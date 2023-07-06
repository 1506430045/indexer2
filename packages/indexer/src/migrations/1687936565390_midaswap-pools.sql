-- Up Migration

CREATE TABLE "midaswap_pools" (
  "address" BYTEA NOT NULL,
  "nft" BYTEA NOT NULL, 
  "token" BYTEA NOT NULL,
  "free_rate" BYTEA NOT NULL
);

ALTER TABLE "midaswap_pools"
  ADD CONSTRAINT "midaswap_pools_pk"
  PRIMARY KEY ("address");

-- Down Migration

DROP TABLE "midaswap_pools";