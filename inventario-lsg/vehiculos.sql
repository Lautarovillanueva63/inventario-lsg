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


-- 2) SEGURIDAD: leer todos los usuarios logueados, escribir solo admin -----
do $$
declare t text;
begin
  foreach t in array array['vehiculos','vencimientos','services_vehiculo','cargas_combustible','distancias_obra','lecturas_vehiculo','documentos_vehiculo'] loop
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
  foreach t in array array['vehiculos','vencimientos','services_vehiculo','cargas_combustible','distancias_obra','lecturas_vehiculo','documentos_vehiculo'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Las fotos (tickets, pólizas, facturas) usan el mismo bucket privado "remitos",
-- dentro de la carpeta "flota/". No hace falta crear nada más.
