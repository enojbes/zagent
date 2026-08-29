/**
 * Confirms the AMO credentials in the environment actually work, without
 * publishing anything.
 *
 * Signing is the last step of a release and the first place a mistyped secret
 * shows up, by which point you have already tagged. This asks AMO who you are
 * instead, which costs nothing and fails early.
 *
 * Reads WEB_EXT_API_KEY and WEB_EXT_API_SECRET. Prints neither.
 */
import { createHmac, randomUUID } from "node:crypto";

const issuer = process.env.WEB_EXT_API_KEY;
const secret = process.env.WEB_EXT_API_SECRET;

if (!issuer || !secret) {
  console.error("WEB_EXT_API_KEY and WEB_EXT_API_SECRET must both be set.");
  process.exit(2);
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;

const res = await fetch("https://addons.mozilla.org/api/v5/accounts/profile/", {
  headers: { Authorization: `JWT ${token}` },
});

if (!res.ok) {
  console.error(`AMO rejected the credentials: HTTP ${res.status}. Check both secrets.`);
  process.exit(1);
}
const profile = await res.json();
console.log(`credentials valid for AMO account ${profile.name ?? profile.username ?? profile.id}`);
