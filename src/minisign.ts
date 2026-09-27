import crypto from "node:crypto";

export interface MinisignPublicKey {
  id: Buffer;
  key: crypto.webcrypto.CryptoKey;
}

export interface MinisignSignature {
  algorithm: Buffer;
  key_id: Buffer;
  signature: Buffer;
  trusted_comment: Buffer;
  global_signature: Buffer;
}

export async function parseKey(keyStr: string): Promise<MinisignPublicKey> {
  const keyInfo = Buffer.from(keyStr, "base64");

  if (
    keyInfo.byteLength !== 42 ||
    !keyInfo.subarray(0, 2).equals(Buffer.from("Ed"))
  ) {
    throw new Error("invalid minisign public key");
  }

  const id = keyInfo.subarray(2, 10);
  const key = keyInfo.subarray(10);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    "Ed25519",
    false,
    ["verify"],
  );

  return { id, key: cryptoKey };
}

export function parseSignature(sigBuf: Buffer): MinisignSignature {
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
    throw new Error(
      "invalid minisign signature: missing newline after untrusted comment",
    );
  }
  currentBuf = currentBuf.subarray(firstNewline + 1);

  // Read and skip signature info
  const sigInfoEnd = currentBuf.indexOf("\n");
  if (sigInfoEnd === -1) {
    throw new Error(
      "invalid minisign signature: missing newline after signature info",
    );
  }
  const sigInfo = decodeBase64(
    currentBuf.subarray(0, sigInfoEnd).toString().replace(/\r$/, ""),
    74,
    "signature",
  );
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
    throw new Error(
      "invalid minisign signature: missing newline after trusted comment",
    );
  }
  const trustedComment = currentBuf
    .subarray(0, trustedCommentEnd)
    .toString()
    .replace(/\r$/, "");
  const trustedCommentBuffer = Buffer.from(trustedComment);
  currentBuf = currentBuf.subarray(trustedCommentEnd + 1);

  // Read and skip global signature
  let globalSigEnd = currentBuf.indexOf("\n");
  if (globalSigEnd === -1) {
    globalSigEnd = currentBuf.length;
  }
  const globalSig = decodeBase64(
    currentBuf.subarray(0, globalSigEnd).toString().replace(/\r$/, ""),
    64,
    "global signature",
  );
  currentBuf = currentBuf.subarray(
    globalSigEnd === currentBuf.length ? globalSigEnd : globalSigEnd + 1,
  );

  // Validate that all data has been consumed
  if (currentBuf.length !== 0 && currentBuf.toString().trim() !== "") {
    throw new Error("invalid minisign signature: trailing bytes");
  }

  return {
    algorithm,
    key_id: keyId,
    signature,
    trusted_comment: trustedCommentBuffer,
    global_signature: globalSig,
  };
}

function decodeBase64(
  value: string,
  expectedLength: number,
  label: string,
): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`invalid minisign signature: malformed ${label}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedLength) {
    throw new Error(`invalid minisign signature: wrong ${label} length`);
  }
  return decoded;
}

export async function verifySignature(
  pubkey: MinisignPublicKey,
  signature: MinisignSignature,
  fileContent: Buffer,
  prehashedContent?: Buffer,
): Promise<boolean> {
  if (!signature.key_id.equals(pubkey.id)) {
    return false; // wrong key
  }

  let signedContent;
  if (signature.algorithm.equals(Buffer.from("ED"))) {
    if (prehashedContent) signedContent = prehashedContent;
    else {
      const hash = crypto.createHash("blake2b512");
      hash.update(fileContent);
      signedContent = hash.digest();
    }
  } else if (signature.algorithm.equals(Buffer.from("Ed"))) {
    signedContent = fileContent;
  } else {
    return false; // unsupported algorithm
  }

  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      pubkey.key,
      Uint8Array.from(signature.signature),
      Uint8Array.from(signedContent),
    ))
  ) {
    return false; // signature verification failure
  }

  const globalSignedContent = Buffer.concat([
    signature.signature,
    signature.trusted_comment,
  ]);
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      pubkey.key,
      Uint8Array.from(signature.global_signature),
      Uint8Array.from(globalSignedContent),
    ))
  ) {
    return false; // signature verification failure
  }

  return true;
}
