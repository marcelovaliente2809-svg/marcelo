-- ═══════════════════════════════════════════════════════════════
--  006 · El nombre del local, puesto a mano
-- ═══════════════════════════════════════════════════════════════
--
--  `contraparte` es lo que dice el correo del banco — a veces el nombre
--  de una cuenta comercial que no se parece en nada al local de verdad
--  («UNIMEDE4» en vez de «Dollar City»). El modelo no inventa ese nombre:
--  sólo lo pone Marcelo, a mano, desde la app.

ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS local TEXT;

COMMENT ON COLUMN movimientos.local IS
  'Nombre del comercio puesto a mano por Marcelo cuando la contraparte '
  '(la cuenta que aparece en el correo del banco) no se parece al local '
  'de verdad. Nunca lo pone el modelo.';
