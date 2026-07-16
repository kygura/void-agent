#!/bin/bash
set -e

# Void - Development Build & Launch Script
# Builds and watches the monorepo packages with hot-reload

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

show_help() {
  cat << EOF
${BLUE}Void Development Script${NC}

Usage: ./scripts/dev.sh [OPTION]

OPTIONS:
  all           Build and watch all packages (default)
  tui           Watch TUI package only
  ai            Watch AI package only
  agent         Watch Agent package only
  coding-agent  Watch coding-agent (void CLI) only
  build         Full production build of all packages
  test          Run tests for all packages
  check         Run biome check + TypeScript check
  clean         Clean build artifacts
  help          Show this help message

EXAMPLES:
  ./scripts/dev.sh              # Default: watch all packages
  ./scripts/dev.sh coding-agent # Watch just the CLI
  ./scripts/dev.sh build        # Production build
EOF
}

# Ensure dependencies are installed
ensure_deps() {
  if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    bun install
  fi
}

dev_all() {
  ensure_deps
  echo -e "${GREEN}Starting development mode for all packages...${NC}"
  bun run dev
}

dev_package() {
  local pkg=$1
  ensure_deps
  echo -e "${GREEN}Starting development mode for $pkg...${NC}"
  cd "packages/$pkg"
  bun run dev
}

build_all() {
  ensure_deps
  echo -e "${GREEN}Building all packages...${NC}"
  bun run build
  echo -e "${GREEN}Build complete!${NC}"
}

run_tests() {
  ensure_deps
  echo -e "${GREEN}Running tests...${NC}"
  bun run test
}

run_check() {
  ensure_deps
  echo -e "${GREEN}Running checks...${NC}"
  bun run check
}

clean() {
  echo -e "${YELLOW}Cleaning build artifacts...${NC}"
  bun run clean
  echo -e "${GREEN}Clean complete!${NC}"
}

# Main logic
case "${1:-all}" in
  all)
    dev_all
    ;;
  tui|ai|agent|coding-agent)
    dev_package "$1"
    ;;
  build)
    build_all
    ;;
  test)
    run_tests
    ;;
  check)
    run_check
    ;;
  clean)
    clean
    ;;
  help|-h|--help)
    show_help
    ;;
  *)
    echo -e "${YELLOW}Unknown option: $1${NC}"
    show_help
    exit 1
    ;;
esac
