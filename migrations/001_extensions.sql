-- pgcrypto provides gen_random_uuid(), used for primary keys.
-- UUIDs over sequential integers: dispute IDs appear in URLs and get shared
-- with processors, and sequential IDs would leak total case volume.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
