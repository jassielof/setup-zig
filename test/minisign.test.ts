import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseKey, parseSignature, verifySignature } from "../src/minisign.js";

const ZIG_KEY = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";

await test("accepts the Zig minisign public key", async () => {
  const key = await parseKey(ZIG_KEY);
  assert.equal(key.id.length, 8);
});

await test("rejects truncated public keys and signatures", async () => {
  await assert.rejects(() => parseKey("RWQ="), /invalid minisign public key/);
  assert.throws(
    () =>
      parseSignature(
        Buffer.from("untrusted comment: x\nAAAA\ntrusted comment: x\nAAAA\n"),
      ),
    /wrong signature length/,
  );
});

await test("verifies a prehashed minisign payload without rereading it", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) throw new Error("Expected an Ed25519 key pair");
  const id = crypto.randomBytes(8);
  const digest = crypto.createHash("blake2b512").update("archive").digest();
  const signature = Buffer.from(
    await crypto.subtle.sign("Ed25519", keys.privateKey, digest),
  );
  const trustedComment = Buffer.from("timestamp:1 file:test.tar.xz hashed");
  const globalSignature = Buffer.from(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      Buffer.concat([signature, trustedComment]),
    ),
  );

  assert.equal(
    await verifySignature(
      { id, key: keys.publicKey },
      {
        algorithm: Buffer.from("ED"),
        key_id: id,
        signature,
        trusted_comment: trustedComment,
        global_signature: globalSignature,
      },
      Buffer.alloc(0),
      digest,
    ),
    true,
  );
});
