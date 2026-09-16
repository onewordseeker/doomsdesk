#!/bin/bash
set -euo pipefail

# DoomsDesk self-hosted deployment script
# Usage: ./deploy.sh [--update]

COMPOSE_FILE="docker-compose.yml"

if [[ "${1:-}" == "--update" ]]; then
  echo "Pulling latest images and rebuilding..."
  docker compose pull
  docker compose build --no-cache
  docker compose up -d
  echo "Update complete."
else
  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      echo "Created .env from .env.example — edit it before running again."
      exit 1
    fi
  fi
  echo "Starting DoomsDesk..."
  docker compose up -d
  echo ""
  echo "DoomsDesk is running:"
  echo "  Web console: http://localhost:3000"
  echo "  API:         http://localhost:4000"
  echo "  Health:      http://localhost:4000/health"
fi
