import test from "node:test";
import assert from "node:assert/strict";
import { parseKey, parseSignature } from "../src/minisign.js";

const ZIG_KEY = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";

test("accepts the Zig minisign public key", async () => {
  const key = await parseKey(ZIG_KEY);
  assert.equal(key.id.length, 8);
});

test("rejects truncated public keys and signatures", async () => {
  await assert.rejects(() => parseKey("RWQ="), /invalid minisign public key/);
  assert.throws(
    () =>
      parseSignature(
        Buffer.from("untrusted comment: x\nAAAA\ntrusted comment: x\nAAAA\n"),
      ),
    /wrong signature length/,
  );
});
