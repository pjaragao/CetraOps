"""Assinatura XMLDSig do leiaute da NF-e (MOC 7.0, item 4.4): envelopada, C14N 1.0, RSA-SHA1 e digest SHA-1, referência ao atributo Id."""
from __future__ import annotations

import base64
import hashlib

from lxml import etree

from .certificate import A1Certificate

DS = "http://www.w3.org/2000/09/xmldsig#"
C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"


def c14n(el: etree._Element) -> bytes:
    """C14N 1.0 inclusiva do elemento. O C14N de sub-árvore do lxml/libxml2 escreve xmlns="" em netos que herdam o namespace padrão
    (o resumo sairia diferente do calculado pela SEFAZ); por isso a canonicalização é feita sobre uma cópia isolada, que já traz
    no próprio elemento os namespaces herdados."""
    alone = etree.fromstring(etree.tostring(el, with_tail=False))
    return etree.tostring(alone, method="c14n", exclusive=False, with_comments=False)


def sign(root: etree._Element, ref_id: str, cert: A1Certificate) -> etree._Element:
    """Devolve uma cópia de `root` (NFe, evento, inutNFe) com <Signature> como último filho, assinando o elemento de atributo Id=`ref_id`.
    A árvore é re-lida do texto antes de resumir/assinar, para que o resultado seja exatamente o que a SEFAZ vai ler."""
    doc = etree.fromstring(etree.tostring(root))
    signed = next((e for e in doc.iter() if e.get("Id") == ref_id), None)
    if signed is None:
        raise ValueError(f"elemento com Id={ref_id} não encontrado")
    digest = base64.b64encode(hashlib.sha1(c14n(signed)).digest()).decode()

    sig = etree.SubElement(doc, f"{{{DS}}}Signature", nsmap={None: DS})
    si = etree.SubElement(sig, f"{{{DS}}}SignedInfo")
    etree.SubElement(si, f"{{{DS}}}CanonicalizationMethod", Algorithm=C14N)
    etree.SubElement(si, f"{{{DS}}}SignatureMethod", Algorithm=f"{DS}rsa-sha1")
    ref = etree.SubElement(si, f"{{{DS}}}Reference", URI=f"#{ref_id}")
    tr = etree.SubElement(ref, f"{{{DS}}}Transforms")
    etree.SubElement(tr, f"{{{DS}}}Transform", Algorithm=f"{DS}enveloped-signature")
    etree.SubElement(tr, f"{{{DS}}}Transform", Algorithm=C14N)
    etree.SubElement(ref, f"{{{DS}}}DigestMethod", Algorithm=f"{DS}sha1")
    etree.SubElement(ref, f"{{{DS}}}DigestValue").text = digest
    etree.SubElement(sig, f"{{{DS}}}SignatureValue")
    ki = etree.SubElement(sig, f"{{{DS}}}KeyInfo")
    x5 = etree.SubElement(ki, f"{{{DS}}}X509Data")
    etree.SubElement(x5, f"{{{DS}}}X509Certificate").text = cert.der_b64

    doc = etree.fromstring(etree.tostring(doc))
    si = doc.find(f"{{{DS}}}Signature/{{{DS}}}SignedInfo")
    doc.find(f"{{{DS}}}Signature/{{{DS}}}SignatureValue").text = base64.b64encode(cert.sign_sha1(c14n(si))).decode()
    return doc
