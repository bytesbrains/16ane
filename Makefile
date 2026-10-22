.PHONY: all build test test-contracts test-sdk-ts test-sdk-py test-cli test-mcp test-server test-facilitator test-indexer test-e2e typecheck fmt fmt-check lint lint-py clean deploy-dry-run coverage coverage-contracts coverage-sdk-ts coverage-sdk-py coverage-cli coverage-mcp coverage-server coverage-facilitator coverage-indexer coverage-scripts coverage-e2e coverage-report

all: build test lint

build:
	forge build --sizes

test: test-contracts test-sdk-ts test-sdk-py test-cli test-mcp test-server test-facilitator test-indexer test-e2e

test-contracts:
	forge test -vvv

test-sdk-ts:
	npm run test:sdk-ts

test-sdk-py:
	npm run test:sdk-py

test-cli:
	npm run test:cli

test-mcp:
	npm run test:mcp

test-server:
	npm run test:server

test-facilitator:
	npm run test:facilitator

test-indexer:
	npm run test:indexer

test-e2e:
	npm run test:e2e

# Coverage mirrors test-* (see "Coverage" in CONTRIBUTING.md). Needs coverage.py
# for python3 (CI pins coverage==7.16.2).
coverage:
	npm run coverage

coverage-contracts:
	mkdir -p coverage && npm run coverage:contracts

coverage-sdk-ts:
	mkdir -p coverage && npm run coverage:sdk-ts

coverage-sdk-py:
	mkdir -p coverage && npm run coverage:sdk-py

coverage-cli:
	mkdir -p coverage && npm run coverage:cli

coverage-mcp:
	mkdir -p coverage && npm run coverage:mcp

coverage-server:
	mkdir -p coverage && npm run coverage:server

coverage-facilitator:
	mkdir -p coverage && npm run coverage:facilitator

coverage-indexer:
	mkdir -p coverage && npm run coverage:indexer

coverage-scripts:
	mkdir -p coverage && npm run coverage:scripts

coverage-e2e:
	mkdir -p coverage && npm run coverage:e2e

coverage-report:
	npm run coverage:report

# Needs `npm ci` first (TypeScript is a dev dependency).
typecheck:
	npm run typecheck

fmt:
	forge fmt

fmt-check:
	forge fmt --check

lint:
	gitleaks detect --config .gitleaks.toml --verbose
	./test/gitleaks/allowlist.test.sh

# Needs ruff on PATH (CI pins ruff==0.16.10).
lint-py:
	ruff check packages/sdk-py

deploy-dry-run:
	PRIVATE_KEY=1 forge script script/DeploySandbox.s.sol:DeploySandbox --chain-id 84532

clean:
	forge clean
