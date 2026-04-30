-- Cada media (imagen / video / audio) puede tener su propia descripción,
-- que va incluida en el archivo markdown que se sube al Vector Store para
-- que el agente IA pueda usarla como caption / contexto.

ALTER TABLE product_media ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
