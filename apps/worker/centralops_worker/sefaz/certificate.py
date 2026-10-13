"""Certificado digital A1 (arquivo .pfx/.p12): assina o XML e autentica a conexão TLS com a SEFAZ."""
from __future__ import annotations

import base64
import os
import re
import secrets
import ssl
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12

from ..adapters.errors import PermanentError

OID_CNPJ = "2.16.76.1.3.3"                  # ICP-Brasil: CNPJ da pessoa jurídica no SubjectAltName (otherName)


def icp_brasil_bundle() -> str:
    """Raízes da ICP-Brasil (os webservices da SVRS usam cadeia ICP-Brasil, que não vem no repositório padrão do sistema)."""
    pem = resources.files(__package__).joinpath("icp_brasil.pem").read_text(encoding="utf-8")
    return "".join(re.findall(r"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----\n?", pem, flags=re.S))


@dataclass
class A1Certificate:
    key: rsa.RSAPrivateKey
    cert: x509.Certificate
    chain: list[x509.Certificate]

    @classmethod
    def from_pfx(cls, data: bytes | str, password: str) -> A1Certificate:
        raw = base64.b64decode(data) if isinstance(data, str) else data
        try:
            key, cert, chain = pkcs12.load_key_and_certificates(raw, (password or "").encode())
        except ValueError as e:
            raise PermanentError("Certificado A1: senha incorreta ou arquivo .pfx inválido") from e
        if cert is None or not isinstance(key, rsa.RSAPrivateKey):
            raise PermanentError("Certificado A1 sem chave RSA: envie o arquivo .pfx completo (com a chave privada)")
        return cls(key, cert, list(chain or []))

    @property
    def not_after(self) -> datetime:
        return self.cert.not_valid_after_utc

    @property
    def subject_cn(self) -> str:
        attrs = self.cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
        return str(attrs[0].value) if attrs else self.cert.subject.rfc4514_string()

    @property
    def cnpj(self) -> str | None:
        """CNPJ do titular: o otherName 2.16.76.1.3.3 da ICP-Brasil; sem ele, os 14 dígitos depois de ':' no nome (padrão 'RAZAO SOCIAL:CNPJ')."""
        try:
            san = self.cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            for other in san.get_values_for_type(x509.OtherName):
                if other.type_id.dotted_string == OID_CNPJ:
                    digits = re.sub(r"\D", "", other.value.decode("latin-1", errors="ignore"))
                    if len(digits) >= 14:
                        return digits[-14:]
        except x509.ExtensionNotFound:
            pass
        m = re.search(r":(\d{14})\b", self.subject_cn)
        return m.group(1) if m else None

    def days_left(self, now: datetime | None = None) -> int:
        return (self.not_after - (now or datetime.now(UTC))).days

    def ensure_valid(self, cnpj: str | None = None) -> None:
        if self.days_left() < 0:
            raise PermanentError(f"Certificado A1 vencido em {self.not_after:%d/%m/%Y}: renove e envie o novo arquivo")
        own = self.cnpj
        if cnpj and own and own[:8] != re.sub(r"\D", "", cnpj)[:8]:
            raise PermanentError(f"O certificado é do CNPJ {own}, que não é da empresa emitente ({cnpj})")

    @property
    def der_b64(self) -> str:
        return base64.b64encode(self.cert.public_bytes(serialization.Encoding.DER)).decode()

    def sign_sha1(self, data: bytes) -> bytes:
        return self.key.sign(data, padding.PKCS1v15(), hashes.SHA1())  # noqa: S303 — algoritmo exigido pelo leiaute da NF-e

    def ssl_context(self) -> ssl.SSLContext:
        """Contexto TLS com autenticação do cliente (o certificado A1) e as raízes ICP-Brasil somadas às do sistema."""
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(cadata=icp_brasil_bundle())
        pw = secrets.token_hex(16)                                     # a chave só toca o disco cifrada e por um instante
        key_pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.BestAvailableEncryption(pw.encode()))
        cert_pem = b"".join(c.public_bytes(serialization.Encoding.PEM) for c in [self.cert, *self.chain])
        fd_c, path_c = tempfile.mkstemp(suffix=".pem")
        fd_k, path_k = tempfile.mkstemp(suffix=".pem")
        try:
            os.write(fd_c, cert_pem)
            os.write(fd_k, key_pem)
            os.close(fd_c)
            os.close(fd_k)
            ctx.load_cert_chain(path_c, path_k, password=pw)
        finally:
            for p in (path_c, path_k):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        return ctx
