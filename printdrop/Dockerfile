# PrintDrop: a drop-off print server for a hard-to-print-to Ricoh.
# Runs on x86-64 and on 64-bit ARM (Raspberry Pi 4/5).
FROM ubuntu:24.04

# LibreOffice lets people drop Word/Excel/PowerPoint files (~400 MB extra).
# Build with --build-arg WITH_OFFICE=false for a small PDF/image-only image.
ARG WITH_OFFICE=true

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PRINTDROP_DATA=/data \
    PRINTDROP_CONFIG=/config/printdrop.yml

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cups cups-client cups-bsd cups-filters ghostscript poppler-utils \
      python3 python3-cups python3-fastapi python3-uvicorn python3-multipart \
      python3-yaml python3-pil python3-qrcode \
      samba samba-vfs-modules tini ca-certificates \
      fonts-dejavu-core fonts-liberation2 \
 && if [ "$WITH_OFFICE" = "true" ]; then \
      apt-get install -y --no-install-recommends \
        libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
        fonts-crosextra-carlito fonts-crosextra-caladea ; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /home/printdrop --groups lpadmin printdrop

WORKDIR /app
COPY printdrop/ /app/printdrop/
COPY ppd/ /app/ppd/
COPY config/printdrop.yml /app/config/printdrop.yml
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/smb.conf /app/docker/smb.conf
RUN chmod 755 /entrypoint.sh \
 && python3 -m compileall -q /app/printdrop

EXPOSE 8080 445
VOLUME ["/data", "/config"]

HEALTHCHECK --interval=30s --timeout=6s --start-period=20s \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=5)"

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
