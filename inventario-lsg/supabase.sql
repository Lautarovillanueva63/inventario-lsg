-- =====================================================================
-- Inventario de Obra LSG — base de datos v2 para Supabase
-- Pegá TODO este archivo en Supabase > SQL Editor > New query > Run
--
-- Se puede volver a correr sin perder datos. Lo único que borra son las
-- tablas de la versión 1 (remitos, movimientos_log), que ya no se usan.
-- Los usuarios y sus roles (tabla perfiles) se conservan.
-- =====================================================================


-- 0) LIMPIEZA DE LA VERSIÓN 1 ------------------------------------------
drop table if exists remitos cascade;
drop table if exists movimientos_log cascade;


-- 1) USUARIOS Y ROLES (igual que antes) ---------------------------------
create table if not exists perfiles (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text not null,
  rol      text not null default 'lector' check (rol in ('admin','lector'))
);

create or replace function crear_perfil() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfiles (user_id, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario after insert on auth.users
  for each row execute function crear_perfil();

insert into perfiles (user_id, email) select id, email from auth.users on conflict do nothing;

create or replace function es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where user_id = auth.uid() and rol = 'admin');
$$;


-- 2) TABLAS --------------------------------------------------------------

-- Ubicaciones: el depósito central y cada obra
create table if not exists ubicaciones (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null unique,
  tipo        text not null default 'obra' check (tipo in ('obra','deposito')),
  direccion   text not null default '',
  activa      boolean not null default true,
  creado_en   timestamptz not null default now()
);

-- Herramientas y equipos: CADA UNIDAD es una fila, con su código y su ubicación actual.
-- "Trompo 1" y "Trompo 2" son dos filas. Moverlas = cambiar ubicacion_id.
create table if not exists herramientas (
  id            uuid primary key default gen_random_uuid(),
  codigo        text unique,                                -- lo genera el trigger: TRO-001
  nombre        text not null,
  descripcion   text not null default '',
  ubicacion_id  uuid references ubicaciones(id),
  de_baja       boolean not null default false,             -- rota, perdida o descartada
  creado_en     timestamptz not null default now()
);

-- Catálogo de materiales: el "qué" (cemento, hierro 8 mm...)
create table if not exists materiales (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  unidad     text not null default 'un',
  creado_en  timestamptz not null default now()
);
create unique index if not exists materiales_nombre_unidad on materiales (lower(nombre), unidad);

-- Foto de cada herramienta y de cada material (ruta dentro del Storage)
alter table herramientas add column if not exists foto text;
alter table materiales   add column if not exists foto text;

-- Stock de materiales: el "cuánto hay de cada material en cada ubicación"
create table if not exists stock_materiales (
  material_id   uuid not null references materiales(id),
  ubicacion_id  uuid not null references ubicaciones(id),
  cantidad      numeric not null check (cantidad >= 0),
  primary key (material_id, ubicacion_id)
);

-- Movimientos: cada alta, ingreso de proveedor, traslado (remito LSG) o consumo.
-- No se editan ni se borran: son el registro histórico. Solo se les agregan fotos.
create sequence if not exists numero_remito;
create table if not exists movimientos (
  id                uuid primary key default gen_random_uuid(),
  tipo              text not null check (tipo in ('alta','proveedor','traslado','consumo')),
  numero            bigint unique,                 -- solo los traslados: remito R-00001
  fecha             date not null default current_date,
  origen_id         uuid references ubicaciones(id),
  destino_id        uuid references ubicaciones(id),
  proveedor         text not null default '',
  numero_proveedor  text not null default '',
  recibe            text not null default '',      -- capataz que firma
  entrega           text not null default '',
  items             jsonb not null default '[]',   -- foto fija de lo que se movió
  fotos             text[] not null default '{}',
  nota              text not null default '',
  creado_por        text,
  creado_en         timestamptz not null default now()
);

-- Eventos: cambios que no son movimientos (alta de obra, cambio de nombre...)
create table if not exists eventos (
  id     bigint generated always as identity primary key,
  texto  text not null,
  por    text,
  en     timestamptz not null default now()
);


-- 3) CÓDIGO AUTOMÁTICO DE HERRAMIENTAS ----------------------------------
-- Toma las 3 primeras letras del nombre y agrega un número correlativo:
-- "Trompo hormigonero" -> TRO-001, TRO-002...  "Amoladora 115" -> AMO-001
create or replace function asignar_codigo() returns trigger
language plpgsql as $$
declare
  pre text;
  n   int;
begin
  if new.codigo is not null and new.codigo <> '' then return new; end if;
  pre := upper(left(regexp_replace(translate(lower(new.nombre), 'áéíóúüñ', 'aeiouun'), '[^a-z]', '', 'g'), 3));
  if length(pre) < 3 then pre := rpad(coalesce(nullif(pre, ''), 'HER'), 3, 'X'); end if;
  perform pg_advisory_xact_lock(hashtext('codigo-' || pre));   -- evita que dos altas simultáneas tomen el mismo número
  select coalesce(max(substring(codigo from '-(\d+)$')::int), 0) + 1 into n
    from herramientas where codigo like pre || '-%';
  new.codigo := pre || '-' || lpad(n::text, 3, '0');
  return new;
end $$;

drop trigger if exists codigo_herramienta on herramientas;
create trigger codigo_herramienta before insert on herramientas
  for each row execute function asignar_codigo();


-- 4) REGISTRAR UN MOVIMIENTO (todo o nada) ------------------------------
-- La página manda un JSON y esta función hace TODO en una sola transacción:
-- valida, mueve herramientas, ajusta stock y guarda el movimiento.
-- Si algo falla (ej. no alcanza el stock), no se guarda NADA.
create or replace function registrar_movimiento(p jsonb) returns movimientos
language plpgsql security definer set search_path = public as $$
declare
  v_tipo    text := p->>'tipo';
  v_origen  uuid := nullif(p->>'origen_id', '')::uuid;
  v_destino uuid := nullif(p->>'destino_id', '')::uuid;
  v_items   jsonb := '[]'::jsonb;
  v_email   text;
  it        jsonb;
  h         herramientas;
  m         materiales;
  v_mov     movimientos;
  v_cant    numeric;
  v_stock   numeric;
  v_n       int;
  v_base    text;
  i         int;
begin
  if not es_admin() then
    raise exception 'Solo un administrador puede registrar movimientos';
  end if;
  select email into v_email from perfiles where user_id = auth.uid();

  if v_tipo is null or v_tipo not in ('alta','proveedor','traslado','consumo') then
    raise exception 'Tipo de movimiento inválido';
  end if;
  if v_tipo in ('alta','proveedor','traslado') and v_destino is null then
    raise exception 'Elegí a dónde va';
  end if;
  if v_tipo in ('traslado','consumo') and v_origen is null then
    raise exception 'Elegí de dónde sale';
  end if;
  if v_tipo = 'traslado' and v_origen = v_destino then
    raise exception 'El origen y el destino tienen que ser distintos';
  end if;
  if v_tipo = 'traslado' and coalesce(trim(p->>'recibe'), '') = '' then
    raise exception 'Escribí quién recibe (el capataz que firma el remito)';
  end if;

  -- Herramientas -------------------------------------------------------
  for it in select value from jsonb_array_elements(coalesce(p->'herramientas', '[]'::jsonb)) loop
    if v_tipo in ('alta','proveedor') then
      -- Unidades nuevas: si cantidad = 3 se crean "Nombre 1", "Nombre 2", "Nombre 3"
      v_base := trim(it->>'nombre');
      if coalesce(v_base, '') = '' then raise exception 'Hay una herramienta sin nombre'; end if;
      v_n := greatest(coalesce((it->>'cantidad')::int, 1), 1);
      if v_n > 200 then raise exception 'Máximo 200 unidades por fila'; end if;
      for i in 1..v_n loop
        insert into herramientas (nombre, descripcion, ubicacion_id)
        values (v_base || case when v_n > 1 then ' ' || i else '' end, coalesce(trim(it->>'descripcion'), ''), v_destino)
        returning * into h;
        v_items := v_items || jsonb_build_object('clase','herramienta','id',h.id,'codigo',h.codigo,'nombre',h.nombre,'descripcion',h.descripcion,'cantidad',1,'unidad','un');
      end loop;
    else
      -- Unidades existentes: tienen que estar en el origen
      select * into h from herramientas where id = (it->>'id')::uuid for update;
      if not found or h.de_baja then
        raise exception 'Una de las herramientas ya no está disponible. Recargá la página.';
      end if;
      if h.ubicacion_id is distinct from v_origen then
        raise exception '% (%) ya no está en el origen elegido. Recargá la página.', h.nombre, h.codigo;
      end if;
      if v_tipo = 'traslado' then
        update herramientas set ubicacion_id = v_destino where id = h.id;
      else
        update herramientas set de_baja = true, ubicacion_id = null where id = h.id;
      end if;
      v_items := v_items || jsonb_build_object('clase','herramienta','id',h.id,'codigo',h.codigo,'nombre',h.nombre,'descripcion',h.descripcion,'cantidad',1,'unidad','un');
    end if;
  end loop;

  -- Materiales ---------------------------------------------------------
  for it in select value from jsonb_array_elements(coalesce(p->'materiales', '[]'::jsonb)) loop
    v_cant := nullif(it->>'cantidad', '')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'Poné una cantidad mayor a cero para %', coalesce(it->>'nombre', 'un material');
    end if;

    if coalesce(it->>'id', '') <> '' then
      select * into m from materiales where id = (it->>'id')::uuid;
      if not found then raise exception 'Un material ya no existe. Recargá la página.'; end if;
    else
      if coalesce(trim(it->>'nombre'), '') = '' then raise exception 'Hay un material sin nombre'; end if;
      select * into m from materiales
        where lower(nombre) = lower(trim(it->>'nombre')) and unidad = coalesce(it->>'unidad', 'un');
      if not found then
        if v_tipo not in ('alta','proveedor') then
          raise exception 'El material % no existe', it->>'nombre';
        end if;
        insert into materiales (nombre, unidad)
        values (trim(it->>'nombre'), coalesce(it->>'unidad', 'un')) returning * into m;
      end if;
    end if;

    if v_tipo in ('traslado','consumo') then
      select cantidad into v_stock from stock_materiales
        where material_id = m.id and ubicacion_id = v_origen for update;
      if coalesce(v_stock, 0) < v_cant then
        raise exception 'En el origen hay % % de % y querés sacar %', coalesce(v_stock, 0), m.unidad, m.nombre, v_cant;
      end if;
      update stock_materiales set cantidad = cantidad - v_cant
        where material_id = m.id and ubicacion_id = v_origen;
      delete from stock_materiales
        where material_id = m.id and ubicacion_id = v_origen and cantidad = 0;
    end if;

    if v_tipo in ('alta','proveedor','traslado') then
      insert into stock_materiales (material_id, ubicacion_id, cantidad)
      values (m.id, v_destino, v_cant)
      on conflict (material_id, ubicacion_id)
      do update set cantidad = stock_materiales.cantidad + excluded.cantidad;
    end if;

    v_items := v_items || jsonb_build_object('clase','material','id',m.id,'nombre',m.nombre,'cantidad',v_cant,'unidad',m.unidad);
  end loop;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'Agregá al menos una herramienta o un material';
  end if;

  insert into movimientos (tipo, numero, fecha, origen_id, destino_id, proveedor, numero_proveedor,
                           recibe, entrega, items, fotos, nota, creado_por)
  values (
    v_tipo,
    case when v_tipo = 'traslado' then nextval('numero_remito') end,
    coalesce(nullif(p->>'fecha', '')::date, current_date),
    case when v_tipo in ('traslado','consumo') then v_origen end,
    case when v_tipo <> 'consumo' then v_destino end,
    coalesce(trim(p->>'proveedor'), ''),
    coalesce(trim(p->>'numero_proveedor'), ''),
    coalesce(trim(p->>'recibe'), ''),
    coalesce(trim(p->>'entrega'), ''),
    v_items,
    array(select jsonb_array_elements_text(coalesce(p->'fotos', '[]'::jsonb))),
    coalesce(trim(p->>'nota'), ''),
    v_email
  )
  returning * into v_mov;

  return v_mov;
end $$;

revoke execute on function registrar_movimiento(jsonb) from public, anon;
grant execute on function registrar_movimiento(jsonb) to authenticated;


-- 5) SEGURIDAD (Row Level Security) -------------------------------------
-- Leer: cualquier usuario logueado.  Escribir: solo admin.
-- El inventario (herramientas, stock) SOLO cambia a través de registrar_movimiento,
-- así nunca hay un cambio de stock sin su movimiento registrado.

alter table perfiles         enable row level security;
alter table ubicaciones      enable row level security;
alter table herramientas     enable row level security;
alter table materiales       enable row level security;
alter table stock_materiales enable row level security;
alter table movimientos      enable row level security;
alter table eventos          enable row level security;

drop policy if exists "ver mi perfil" on perfiles;
create policy "ver mi perfil" on perfiles for select to authenticated using (user_id = auth.uid());

drop policy if exists "leer ubicaciones"         on ubicaciones;
drop policy if exists "admin ubicaciones"        on ubicaciones;
drop policy if exists "admin ubicaciones edita"  on ubicaciones;
create policy "leer ubicaciones"        on ubicaciones for select to authenticated using (true);
create policy "admin ubicaciones"       on ubicaciones for insert to authenticated with check (es_admin());
create policy "admin ubicaciones edita" on ubicaciones for update to authenticated using (es_admin()) with check (es_admin());

drop policy if exists "leer herramientas"        on herramientas;
drop policy if exists "admin renombra herramienta" on herramientas;
create policy "leer herramientas"          on herramientas for select to authenticated using (true);
create policy "admin renombra herramienta" on herramientas for update to authenticated using (es_admin()) with check (es_admin());
-- De herramientas, el admin solo puede editar nombre y descripción a mano (no la ubicación):
revoke update on herramientas from authenticated, anon;
grant update (nombre, descripcion, foto) on herramientas to authenticated;

drop policy if exists "leer materiales"        on materiales;
drop policy if exists "admin renombra material" on materiales;
create policy "leer materiales"         on materiales for select to authenticated using (true);
create policy "admin renombra material" on materiales for update to authenticated using (es_admin()) with check (es_admin());
revoke update on materiales from authenticated, anon;
grant update (nombre, foto) on materiales to authenticated;

drop policy if exists "leer stock" on stock_materiales;
create policy "leer stock" on stock_materiales for select to authenticated using (true);

drop policy if exists "leer movimientos"        on movimientos;
drop policy if exists "admin adjunta fotos"     on movimientos;
create policy "leer movimientos"    on movimientos for select to authenticated using (true);
create policy "admin adjunta fotos" on movimientos for update to authenticated using (es_admin()) with check (es_admin());
-- De un movimiento ya registrado solo se pueden agregar fotos (el remito firmado):
revoke update on movimientos from authenticated, anon;
grant update (fotos) on movimientos to authenticated;

drop policy if exists "leer eventos"  on eventos;
drop policy if exists "admin eventos" on eventos;
create policy "leer eventos"  on eventos for select to authenticated using (true);
create policy "admin eventos" on eventos for insert to authenticated with check (es_admin());


-- 6) FOTOS (Storage) ----------------------------------------------------
insert into storage.buckets (id, name, public)
values ('remitos', 'remitos', false)
on conflict (id) do nothing;

drop policy if exists "equipo ve fotos"   on storage.objects;
drop policy if exists "equipo sube fotos" on storage.objects;
drop policy if exists "ver fotos remitos" on storage.objects;
drop policy if exists "admin sube fotos"  on storage.objects;
create policy "ver fotos remitos" on storage.objects for select to authenticated using (bucket_id = 'remitos');
create policy "admin sube fotos"  on storage.objects for insert to authenticated with check (bucket_id = 'remitos' and es_admin());


-- 7) TIEMPO REAL --------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ubicaciones','herramientas','materiales','stock_materiales','movimientos','eventos'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;


-- 8) DATOS INICIALES ----------------------------------------------------
-- Solo si todavía no hay ningún depósito (si lo renombraste, no se duplica)
insert into ubicaciones (nombre, tipo)
select 'Depósito Central', 'deposito'
where not exists (select 1 from ubicaciones where tipo = 'deposito');

-- =====================================================================
-- Para borrar las obras de prueba de la versión anterior (solo una vez):
--   delete from ubicaciones where nombre <> 'Depósito Central'
--     and id not in (select ubicacion_id from herramientas where ubicacion_id is not null)
--     and id not in (select ubicacion_id from stock_materiales)
--     and id not in (select coalesce(origen_id, destino_id) from movimientos)
--     and id not in (select coalesce(destino_id, origen_id) from movimientos);
--
-- Para hacer admin a alguien:
--   update perfiles set rol = 'admin' where email = 'mail@ejemplo.com';
-- =====================================================================
