-- =====================================================================
-- EMPEZAR DE CERO — borra todos los DATOS de prueba
--
-- Borra: herramientas, materiales, stock, remitos y movimientos, eventos,
--        obras y todo lo de vehículos.
-- Conserva: los usuarios, sus roles y los depósitos (con su nombre).
-- La numeración de remitos vuelve a R-00001 y los códigos a 001.
--
-- ¡No se puede deshacer! Correlo solo cuando terminen las pruebas.
-- Las fotos subidas se borran aparte: Storage > remitos > seleccionar todo > Delete.
-- =====================================================================
begin;

-- Vehículos (si todavía no corriste vehiculos.sql, estas líneas se saltean solas)
do $$
declare t text;
begin
  foreach t in array array['cargas_combustible','services_vehiculo','vencimientos','lecturas_vehiculo',
                           'documentos_vehiculo','distancias_obra','vehiculos'] loop
    if to_regclass('public.'||t) is not null then execute format('delete from %I', t); end if;
  end loop;
end $$;

-- Inventario
delete from movimientos;
delete from stock_materiales;
delete from herramientas;
delete from materiales;
delete from eventos;
delete from ubicaciones where tipo <> 'deposito';      -- se conservan los depósitos con el nombre que tengan

-- Numeración de remitos desde R-00001
alter sequence numero_remito restart with 1;

commit;

-- Verificación: 0 en todo menos ubicaciones (tus depósitos) y perfiles (tus usuarios)
select 'herramientas' as tabla, count(*) from herramientas
union all select 'materiales', count(*) from materiales
union all select 'movimientos', count(*) from movimientos
union all select 'ubicaciones', count(*) from ubicaciones
union all select 'perfiles (usuarios)', count(*) from perfiles;
