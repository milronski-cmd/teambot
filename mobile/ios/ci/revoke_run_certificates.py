#!/usr/bin/env python3
"""Revoke the Apple Development certificate that Xcode created on this CI runner.

With automatic signing, `xcodebuild archive -allowProvisioningUpdates` signs the archive with an "Apple Development"
identity. A fresh runner has none, so Xcode creates one through the App Store Connect API ("Created via API"). Its
private key exists only on this throw-away runner and Apple limits how many a team may have, so after the build this
script revokes exactly the certificates whose private key is in this runner's keychain. The build that goes to
TestFlight is signed at export with Apple's cloud-managed distribution certificate and is not affected.

Standard library and /usr/bin/openssl only. Reads ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID. Never prints the key.
Always exits 0: a failed clean-up must not fail a good upload (it only prints a warning with what to do).
"""
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(sig: bytes) -> bytes:
    """ECDSA-Sig-Value (DER SEQUENCE of two INTEGERs) -> r || s, 32 bytes each (JWT ES256)."""

    def length(b: bytes, i: int):
        n = b[i]
        i += 1
        if n & 0x80:
            k = n & 0x7F
            n = int.from_bytes(b[i : i + k], "big")
            i += k
        return n, i

    if not sig or sig[0] != 0x30:
        raise ValueError("signature is not a DER sequence")
    _, i = length(sig, 1)
    out = b""
    for _ in range(2):
        if sig[i] != 0x02:
            raise ValueError("signature part is not a DER integer")
        n, i = length(sig, i + 1)
        out += sig[i : i + n].lstrip(b"\x00").rjust(32, b"\x00")
        i += n
    return out


def jwt(key_path: str, key_id: str, issuer: str) -> str:
    header = b64url(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64url(json.dumps({"iss": issuer, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}).encode())
    signing_input = f"{header}.{payload}".encode()
    der = subprocess.run(["/usr/bin/openssl", "dgst", "-sha256", "-sign", key_path], input=signing_input, capture_output=True, check=True).stdout
    return f"{header}.{payload}.{b64url(der_to_raw(der))}"


def call(method: str, path: str, token: str):
    req = urllib.request.Request(API + path, method=method, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        return json.loads(body) if body else None


def normalize(serial: str) -> str:
    return serial.strip().upper().lstrip("0")


def local_development_serials() -> set:
    """Serial numbers of the "Apple Development" identities (certificate + private key) in this runner's keychains."""
    ids = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], capture_output=True, text=True).stdout
    hashes = set(re.findall(r'\)\s+([0-9A-F]{40})\s+"Apple Development', ids))
    if not hashes:
        return set()
    pems = subprocess.run(["security", "find-certificate", "-a", "-Z", "-p"], capture_output=True, text=True).stdout
    serials = set()
    # Per certificate: "SHA-256 hash: …" and "SHA-1 hash: …" (either order), then the PEM.
    pattern = r"SHA-1 hash: ([0-9A-F]{40})\s*(?:SHA-256 hash: [0-9A-F]{64}\s*)?(-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----)"
    for m in re.finditer(pattern, pems, re.S):
        if m.group(1) not in hashes:
            continue
        out = subprocess.run(["/usr/bin/openssl", "x509", "-noout", "-serial"], input=m.group(2), capture_output=True, text=True).stdout
        if "=" in out:
            serials.add(normalize(out.split("=", 1)[1]))
    return serials


def main() -> int:
    key_path = os.environ.get("ASC_KEY_PATH", "")
    key_id = os.environ.get("ASC_KEY_ID", "")
    issuer = os.environ.get("ASC_ISSUER_ID", "")
    if not (key_path and key_id and issuer and os.path.exists(key_path)):
        print("Geen App Store Connect-sleutel op deze runner: niets in te trekken.")
        return 0
    serials = local_development_serials()
    if not serials:
        print("Deze run heeft geen ontwikkelaarscertificaat aangemaakt: niets in te trekken.")
        return 0
    try:
        token = jwt(key_path, key_id, issuer)
        query = urllib.parse.urlencode({"filter[certificateType]": "DEVELOPMENT,IOS_DEVELOPMENT", "limit": "200", "fields[certificates]": "serialNumber,name,certificateType"})
        listing = call("GET", f"/certificates?{query}", token) or {}
        revoked = 0
        for cert in listing.get("data", []):
            attrs = cert.get("attributes", {})
            if normalize(str(attrs.get("serialNumber", ""))) in serials:
                call("DELETE", f"/certificates/{cert['id']}", token)
                revoked += 1
                print(f"Ingetrokken: {attrs.get('name', 'Apple Development')} (alleen gebruikt door deze run)")
        if not revoked:
            print("::warning::Het ontwikkelaarscertificaat van deze run is niet gevonden bij Apple. Zie je later 'maximum number of certificates', trek dan oude 'Created via API'-certificaten in onder Certificates op developer.apple.com.")
    except (urllib.error.URLError, subprocess.CalledProcessError, ValueError, KeyError) as e:
        status = getattr(e, "code", "")
        print(f"::warning::Opruimen van het ontwikkelaarscertificaat lukte niet ({type(e).__name__} {status}). Trek het zo nodig zelf in onder Certificates op developer.apple.com.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
