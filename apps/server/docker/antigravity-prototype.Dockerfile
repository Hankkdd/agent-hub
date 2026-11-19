FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

ARG TARGETARCH
RUN test "$TARGETARCH" = arm64 || { echo 'Prototype supports linux/arm64 only' >&2; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# Captured from the official linux_arm64 manifest; never resolve latest during a build.
RUN curl --fail --location --max-time 180 \
 https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.6-5068262057312256/linux-arm/cli_linux_arm64.tar.gz -o /tmp/agy.tar.gz \
 && echo 'dbe9585460ba8ea30959c6a2599d3bef1e7710331ef8c9e418863a300d19351906e16be63204f7d77434c773796b5ae222ae135ac033db5abf1542b076d02b0e  /tmp/agy.tar.gz' | sha512sum -c - \
 && tar -xzf /tmp/agy.tar.gz -C /usr/local/bin antigravity \
 && mv /usr/local/bin/antigravity /usr/local/bin/agy \
 && chmod 0555 /usr/local/bin/agy && rm /tmp/agy.tar.gz
RUN mkdir -p /home/prototype/.gemini/config /home/prototype/.gemini/antigravity-cli /work \
 && touch /home/prototype/.gemini/antigravity-cli/settings.json \
 && chmod 0755 /home/prototype /work
ENV HOME=/home/prototype AGY_CLI_DISABLE_AUTO_UPDATE=true GEMINI_FORCE_FILE_STORAGE=true TZ=UTC
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["agy"]
