#!/usr/bin/env python3
"""Decrypt V2 .dat media file using kvcomm-derived keys.

Usage:
  python3 decrypt_v2.py <src.dat> <dest_out>
"""
import sys
import hashlib
import os
from pathlib import Path

try:
    from Crypto.Cipher import AES
except ImportError:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
        USE_CRYPTOGRAPHY = True
    except ImportError:
        print("Need pycryptodome or cryptography: pip install pycryptodome", file=sys.stderr)
        sys.exit(1)
else:
    USE_CRYPTOGRAPHY = False


def aes_ecb_decrypt(ciphertext: bytes, key: bytes) -> bytes:
    if USE_CRYPTOGRAPHY:
        cipher = Cipher(algorithms.AES(key), modes.ECB(), backend=default_backend())
        d = cipher.decryptor()
        return d.update(ciphertext) + d.finalize()
    else:
        return AES.new(key, AES.MODE_ECB).decrypt(ciphertext)


def pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        return data
    pad = data[-1]
    if 0 < pad <= 16 and all(b == pad for b in data[-pad:]):
        return data[:-pad]
    return data


def detect_ext(data: bytes) -> str:
    if len(data) >= 2 and data[:2] == b'\xff\xd8':
        return 'jpg'
    if len(data) >= 4 and data[:4] == b'\x89PNG':
        return 'png'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    if len(data) >= 4 and data[:4] == b'GIF8':
        return 'gif'
    return 'bin'


def decrypt_v2(src_path: str, dest_path: str, aes_key: bytes, xor_key: int):
    with open(src_path, 'rb') as f:
        data = f.read()

    if data[:6] != b'\x07\x08\x56\x32\x08\x07':
        raise ValueError(f"Not V2: magic={data[:6].hex()}")

    aes_len = int.from_bytes(data[6:10], 'little')
    xor_len = int.from_bytes(data[10:14], 'little')

    if aes_len % 16 == 0:
        aes_cipher_len = aes_len + 16
    else:
        aes_cipher_len = ((aes_len + 15) // 16) * 16

    encrypted = data[15:15 + aes_cipher_len]
    decrypted = aes_ecb_decrypt(encrypted, aes_key)
    unpadded = pkcs7_unpad(decrypted)

    result = bytearray(unpadded)
    body_start = 15 + aes_cipher_len
    xor_start = len(data) - xor_len
    if xor_start > body_start:
        result.extend(data[body_start:xor_start])

    for b in data[xor_start:]:
        result.append(b ^ xor_key)

    ext = detect_ext(bytes(result[:100]))
    with open(dest_path, 'wb') as f:
        f.write(result)
    return ext, len(result)


def derive_keys(code: int, clean_account_id: str):
    xor_key = code & 0xff
    digest = hashlib.md5(f"{code}{clean_account_id}".encode()).hexdigest()
    aes_key = digest[:16].encode('ascii')
    return aes_key, xor_key


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    src = sys.argv[1]
    dest = sys.argv[2]

    code = int(os.environ.get('TG_CODE', '1569355244'))
    account = os.environ.get('TG_ACCOUNT', 'wxid_k5w9iugg43l621')

    aes_key, xor_key = derive_keys(code, account)
    print(f"code={code} account={account} xor=0x{xor_key:02x} aes={aes_key.decode()}")

    ext, size = decrypt_v2(src, dest, aes_key, xor_key)
    print(f"OK: wrote {size} bytes, ext={ext} -> {dest}")
