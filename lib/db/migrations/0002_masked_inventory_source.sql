CREATE TABLE masked_inventory_source (
  id varchar(40) PRIMARY KEY,
  source_version varchar(64) NOT NULL,
  report jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);