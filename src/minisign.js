import crypto from "node:crypto";

/**
 * Parses a minisign public key base64 string.
 * @param {string} keyStr
 * @returns {Promise<{id: Buffer, key: CryptoKey}>}
 */
export async function parseKey(keyStr) {
  const keyInfo = Buffer.from(keyStr, "base64");

  const id = keyInfo.subarray(2, 10);
  const key = keyInfo.subarray(10);

  if (key.byteLength !== 32) {
    throw new Error("invalid public key given");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    "Ed25519",
    false,
    ["verify"]
  );

  return { id, key: cryptoKey };
}

/**
 * Parses a minisign signature buffer.
 * @param {Buffer} sigBuf
 * @returns {{algorithm: Buffer, key_id: Buffer, signature: Buffer, trusted_comment: Buffer, global_signature: Buffer}}
 */
export function parseSignature(sigBuf) {
  const untrustedHeader = Buffer.from("untrusted comment: ");
  const trustedHeader = Buffer.from("trusted comment: ");

  // Validate untrusted comment header, and skip
  if (!sigBuf.subarray(0, untrustedHeader.byteLength).equals(untrustedHeader)) {
    throw new Error("invalid minisign signature: bad untrusted comment header");
  }
  let currentBuf = sigBuf.subarray(untrustedHeader.byteLength);

  // Skip untrusted comment
  const firstNewline = currentBuf.indexOf("\n");
  if (firstNewline === -1) {
    throw new Error("invalid minisign signature: missing newline after untrusted comment");
  }
  currentBuf = currentBuf.subarray(firstNewline + 1);

  // Read and skip signature info
  const sigInfoEnd = currentBuf.indexOf("\n");
  if (sigInfoEnd === -1) {
    throw new Error("invalid minisign signature: missing newline after signature info");
  }
  const sigInfo = Buffer.from(currentBuf.subarray(0, sigInfoEnd).toString(), "base64");
  currentBuf = currentBuf.subarray(sigInfoEnd + 1);

  // Extract components of signature info
  const algorithm = sigInfo.subarray(0, 2);
  const keyId = sigInfo.subarray(2, 10);
  const signature = sigInfo.subarray(10);

  // Validate trusted comment header, and skip
  if (!currentBuf.subarray(0, trustedHeader.byteLength).equals(trustedHeader)) {
    throw new Error("invalid minisign signature: bad trusted comment header");
  }
  currentBuf = currentBuf.subarray(trustedHeader.byteLength);

  // Read and skip trusted comment
  const trustedCommentEnd = currentBuf.indexOf("\n");
  if (trustedCommentEnd === -1) {
    throw new Error("invalid minisign signature: missing newline after trusted comment");
  }
  const trustedComment = currentBuf.subarray(0, trustedCommentEnd);
  currentBuf = currentBuf.subarray(trustedCommentEnd + 1);

  // Read and skip global signature
  let globalSigEnd = currentBuf.indexOf("\n");
  if (globalSigEnd === -1) {
    globalSigEnd = currentBuf.length;
  }
  const globalSig = Buffer.from(currentBuf.subarray(0, globalSigEnd).toString(), "base64");
  currentBuf = currentBuf.subarray(globalSigEnd === currentBuf.length ? globalSigEnd : globalSigEnd + 1);

  // Validate that all data has been consumed
  if (currentBuf.length !== 0 && currentBuf.toString().trim() !== "") {
    throw new Error("invalid minisign signature: trailing bytes");
  }

  return {
    algorithm,
    key_id: keyId,
    signature,
    trusted_comment: trustedComment,
    global_signature: globalSig,
  };
}

/**
 * Verifies a file content against a parsed signature and public key.
 * @param {{id: Buffer, key: CryptoKey}} pubkey
 * @param {{algorithm: Buffer, key_id: Buffer, signature: Buffer, trusted_comment: Buffer, global_signature: Buffer}} signature
 * @param {Buffer} fileContent
 * @returns {Promise<boolean>}
 */
export async function verifySignature(pubkey, signature, fileContent) {
  if (!signature.key_id.equals(pubkey.id)) {
    return false; // wrong key
  }

  let signedContent;
  if (signature.algorithm.equals(Buffer.from("ED"))) {
    const hash = crypto.createHash("blake2b512");
    hash.update(fileContent);
    signedContent = hash.digest();
  } else if (signature.algorithm.equals(Buffer.from("Ed"))) {
    signedContent = fileContent;
  } else {
    return false; // unsupported algorithm
  }

  if (!await crypto.subtle.verify("Ed25519", pubkey.key, signature.signature, signedContent)) {
    return false; // signature verification failure
  }

  const globalSignedContent = Buffer.concat([signature.signature, signature.trusted_comment]);
  if (!await crypto.subtle.verify("Ed25519", pubkey.key, signature.global_signature, globalSignedContent)) {
    return false; // signature verification failure
  }

  return true;
}
