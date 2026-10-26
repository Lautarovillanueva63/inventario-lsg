-- =====================================================================
-- Flota de vehículos LSG — base de datos para Supabase
-- Correlo DESPUÉS de supabase.sql (usa sus usuarios, roles y obras).
-- Pegá TODO este archivo en Supabase > SQL Editor > New query > Run
--
-- No toca nada del inventario de materiales y herramientas.
-- Se puede volver a correr sin perder datos.
-- =====================================================================


-- 1) TABLAS --------------------------------------------------------------

-- Vehículos: la ficha de cada uno
create table if not exists vehiculos (
  id                  uuid primary key default gen_random_uuid(),
  patente             text not null unique,
  marca               text not null default '',
  modelo              text not null default '',
  anio                int,
  tipo                text not null default 'camioneta'
                      check (tipo in ('camioneta','camion','utilitario','auto','maquina','otro')),
  combustible         text not null default 'gasoil' check (combustible in ('gasoil','nafta','gnc','otro')),
  km_l_ref            numeric check (km_l_ref is null or km_l_ref > 0),   -- rendimiento de referencia (km por litro)
  km_inicial          int not null default 0 check (km_inicial >= 0),     -- odómetro al darlo de alta
  service_cada_km     int not null default 10000 check (service_cada_km > 0),
  service_cada_meses  int not null default 6 check (service_cada_meses > 0),
  chofer              text not null default '',
  obra_id             uuid references ubicaciones(id),                    -- obra donde está trabajando
  activo              boolean not null default true,                      -- false = vendido o fuera de servicio
  nota                text not null default '',
  creado_en           timestamptz not null default now()
);

-- Vencimientos: VTV, seguro, patente, RUTA, registro del chofer...
-- Cada renovación es una fila nueva: así queda el historial. El vigente es el de fecha más lejana.
create table if not exists vencimientos (
  id           uuid primary key default gen_random_uuid(),
  vehiculo_id  uuid not null references vehiculos(id) on delete cascade,
  tipo         text not null check (tipo in ('vtv','seguro','patente','ruta','registro','otro')),
  detalle      text not null default '',     -- ej. "Póliza 123456 · La Segunda" o "Juan Pérez · cat. B1"
  vence        date not null,
  fotos        text[] not null default '{}',
  creado_por   text,
  creado_en    timestamptz not null default now()
);

-- Services y reparaciones
create table if not exists services_vehiculo (
  id           uuid primary key default gen_random_uuid(),
  vehiculo_id  uuid not null references vehiculos(id) on delete cascade,
  fecha        date not null default current_date,
  km           int not null check (km >= 0),
  tipo         text not null default 'service' check (tipo in ('service','reparacion','cubiertas','otro')),
  taller       text not null default '',
  costo        numeric check (costo is null or costo >= 0),
  detalle      text not null default '',
  fotos        text[] not null default '{}',
  creado_por   text,
  creado_en    timestamptz not null default now()
);

-- Cargas de combustible (una por línea del resumen de la tarjeta de flota)
create table if not exists cargas_combustible (
  id           uuid primary key default gen_random_uuid(),
  vehiculo_id  uuid not null references vehiculos(id) on delete cascade,
  fecha        date not null,
  odometro     int not null check (odometro >= 0),
  litros       numeric not null check (litros > 0),
  monto        numeric check (monto is null or monto >= 0),
  obra_id      uuid references ubicaciones(id),        -- a qué obra se imputa
  estacion     text not null default '',
  nota         text not null default '',
  fotos        text[] not null default '{}',
  creado_por   text,
  creado_en    timestamptz not null default now()
);
create index if not exists cargas_vehiculo_odo on cargas_combustible (vehiculo_id, odometro);

-- Máquinas que se controlan por HORAS de uso (horómetro) en vez de km.
-- Si unidad = 'horas': km_inicial, km de services, odómetro de cargas y lecturas
-- guardan HORAS; service_cada_km es "cada X horas"; km_l_ref es litros por hora.
alter table vehiculos add column if not exists unidad text not null default 'km';
do $$ begin
  alter table vehiculos add constraint vehiculos_unidad_check check (unidad in ('km','horas'));
exception when duplicate_object then null; end $$;

-- Lecturas de odómetro / horómetro: para tener los km u horas al día sin esperar una carga
create table if not exists lecturas_vehiculo (
  id           uuid primary key default gen_random_uuid(),
  vehiculo_id  uuid not null references vehiculos(id) on delete cascade,
  fecha        date not null default current_date,
  valor        int not null check (valor >= 0),
  nota         text not null default '',
  creado_por   text,
  creado_en    timestamptz not null default now()
);

-- Documentos del vehículo: póliza, VTV, cédula, título, etc. (PDF o fotos)
create table if not exists documentos_vehiculo (
  id           uuid primary key default gen_random_uuid(),
  vehiculo_id  uuid not null references vehiculos(id) on delete cascade,
  tipo         text not null default 'otro' check (tipo in ('poliza','vtv','cedula','titulo','registro','ruta','otro')),
  detalle      text not null default '',
  archivos     text[] not null default '{}',
  creado_por   text,
  creado_en    timestamptz not null default now()
);

-- Distancia de cada obra (solo ida, desde la base): para calcular "viajes equivalentes"
create table if not exists distancias_obra (
  obra_id  uuid primary key references ubicaciones(id),
  km_ida   numeric not null check (km_ida >= 0)
);


-- Agregado (octubre 2026): matafuegos como vencimiento y como tipo de documento
-- (se reemplaza la lista de tipos permitidos; los datos que ya hay no cambian)
alter table vencimientos drop constraint if exists vencimientos_tipo_check;
alter table vencimientos add constraint vencimientos_tipo_check
  check (tipo in ('vtv','seguro','patente','ruta','registro','matafuegos','otro'));
alter table documentos_vehiculo drop constraint if exists documentos_vehiculo_tipo_check;
alter table documentos_vehiculo add constraint documentos_vehiculo_tipo_check
  check (tipo in ('poliza','vtv','cedula','titulo','registro','ruta','matafuegos','otro'));


-- Agregado (octubre 2026): historial de obras de cada vehículo y máquina.
-- Cada vez que cambia la obra asignada (editando el vehículo o con "Trasladar"), queda una fila acá.
create table if not exists asignaciones_vehiculo (
  id             uuid primary key default gen_random_uuid(),
  vehiculo_id    uuid not null references vehiculos(id) on delete cascade,
  obra_id        uuid references ubicaciones(id),          -- null = sin obra asignada
  desde          date not null default current_date,
  transporte     text not null default '',
  nota           text not null default '',
  movimiento_id  uuid references movimientos(id),          -- el remito, si se hizo con remito
  creado_por     text,
  creado_en      timestamptz not null default now()
);
create index if not exists asignaciones_vehiculo_idx on asignaciones_vehiculo (vehiculo_id, desde desc);

create or replace function registrar_asignacion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.obra_id is distinct from old.obra_id then
    insert into asignaciones_vehiculo (vehiculo_id, obra_id, creado_por)
    values (new.id, new.obra_id, (select email from perfiles where user_id = auth.uid()));
  end if;
  return new;
end $$;
drop trigger if exists asignacion_vehiculo on vehiculos;
create trigger asignacion_vehiculo after insert or update of obra_id on vehiculos
  for each row execute function registrar_asignacion();

-- Trasladar una máquina o vehículo a otra obra (todo o nada). Si con_remito = true, genera un
-- remito LSG numerado (igual que los de herramientas) para imprimir y firmar.
--   {vehiculo_id, destino_id, fecha, transporte, nota, con_remito}
create or replace function trasladar_vehiculo(p jsonb) returns asignaciones_vehiculo
language plpgsql security definer set search_path = public as $$
declare
  v       vehiculos;
  v_orig  uuid;
  v_dest  uuid := nullif(p->>'destino_id', '')::uuid;
  v_mov   movimientos;
  a       asignaciones_vehiculo;
begin
  if not es_admin() then raise exception 'Solo un administrador puede trasladar vehículos'; end if;
  select * into v from vehiculos where id = (p->>'vehiculo_id')::uuid for update;
  if not found then raise exception 'El vehículo ya no existe. Recargá la página.'; end if;
  if v_dest is null then raise exception 'Elegí a qué obra va'; end if;
  v_orig := coalesce(v.obra_id, (select id from ubicaciones where tipo = 'deposito' and activa order by creado_en limit 1));
  if v_orig = v_dest then raise exception 'Ya está asignado a esa obra'; end if;

  if coalesce((p->>'con_remito')::boolean, false) then
    v_mov := registrar_movimiento(jsonb_build_object(
      'tipo', 'traslado', 'origen_id', v_orig, 'destino_id', v_dest, 'fecha', p->>'fecha',
      'transporte', p->>'transporte', 'nota', p->>'nota',
      'equipos', jsonb_build_array(jsonb_build_object('id', v.id, 'codigo', v.patente,
                   'nombre', coalesce(nullif(upper(trim(concat_ws(' ', nullif(v.marca,''), nullif(v.modelo,'')))), ''), 'EQUIPO ' || v.patente),
                   'descripcion', ''))));
  end if;

  update vehiculos set obra_id = v_dest where id = v.id;      -- el trigger crea la fila del historial
  update asignaciones_vehiculo set
      desde = coalesce(nullif(p->>'fecha', '')::date, current_date),
      transporte = coalesce(trim(p->>'transporte'), ''), nota = coalesce(trim(p->>'nota'), ''),
      movimiento_id = v_mov.id
    where id = (select id from asignaciones_vehiculo where vehiculo_id = v.id order by creado_en desc limit 1)
    returning * into a;
  return a;
end $$;
revoke execute on function trasladar_vehiculo(jsonb) from public, anon;
grant execute on function trasladar_vehiculo(jsonb) to authenticated;

-- Punto de partida del historial: la obra que tiene hoy cada vehículo (solo la primera vez)
insert into asignaciones_vehiculo (vehiculo_id, obra_id, desde, nota)
select id, obra_id, creado_en::date, 'Asignación al instalar el historial'
  from vehiculos v where not exists (select 1 from asignaciones_vehiculo a where a.vehiculo_id = v.id);


-- 2) SEGURIDAD: leer todos los usuarios logueados, escribir solo admin -----
do $$
declare t text;
begin
  foreach t in array array['vehiculos','vencimientos','services_vehiculo','cargas_combustible','distancias_obra','lecturas_vehiculo','documentos_vehiculo','asignaciones_vehiculo'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "leer %s" on %I', t, t);
    execute format('drop policy if exists "admin %s" on %I', t, t);
    execute format('create policy "leer %s" on %I for select to authenticated using (true)', t, t);
    execute format('create policy "admin %s" on %I for all to authenticated using (es_admin()) with check (es_admin())', t, t);
  end loop;
end $$;


-- 3) TIEMPO REAL ----------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['vehiculos','vencimientos','services_vehiculo','cargas_combustible','distancias_obra','lecturas_vehiculo','documentos_vehiculo','asignaciones_vehiculo'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Las fotos (tickets, pólizas, facturas) usan el mismo bucket privado "remitos",
-- dentro de la carpeta "flota/". No hace falta crear nada más.
