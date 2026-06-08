-- Columnas de demanda y estabilidad en units (si aún no existen).
alter table public.units
  add column if not exists demanda numeric,
  add column if not exists estabilidad text;

comment on column public.units.demanda is 'Nota de demanda del mercado (0-10).';
comment on column public.units.estabilidad is 'stable | dropping | fluctuating';

-- Mercado inestable: marcar todas las unidades como fluctuating por defecto.
update public.units
set estabilidad = 'fluctuating'
where estabilidad is null
   or trim(estabilidad) = '';
