# syntax=docker/dockerfile:1

# --- Stage 1: compile the v2fly/geoip CLI that geoip.js shells out to ---
# This is the `geoip` binary you have at ~/go/bin/geoip on your machine.
# CGO_ENABLED=0 makes it a fully static binary so it runs in the slim Node image.
FROM golang:1.25-bookworm AS geoip-builder
# GOTOOLCHAIN=auto lets Go fetch a newer toolchain if the pinned geoip version
# bumps its required Go version again.
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
RUN go install github.com/v2fly/geoip@v0.0.0-20260619111430-519243fd551c

# --- Stage 2: the Node runtime that actually runs the job ---
FROM node:24-slim

WORKDIR /app

# Bring in just the compiled geoip binary, onto PATH as `geoip`.
COPY --from=geoip-builder /go/bin/geoip /usr/local/bin/geoip

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Defaults for a scheduled serverless run; override per-environment in the
# ECS task definition. Secrets (MaxMind / R2 keys) are injected there, NOT baked in.
ENV R2_UPLOAD_ENABLED=true \
    GEOIP_TRIGGERED_BY=scheduled

# Run the job once and exit (not the long-lived server.js).
CMD ["node", "worker.js"]
