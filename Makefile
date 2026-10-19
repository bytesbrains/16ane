.PHONY: all build test test-contracts test-sdk-ts test-sdk-py test-cli test-server test-e2e typecheck fmt fmt-check lint lint-py clean deploy-dry-run

all: build test lint

build:
	forge build --sizes

test: test-contracts test-sdk-ts test-sdk-py test-cli test-server test-e2e

test-contracts:
	forge test -vvv

test-sdk-ts:
	npm run test:sdk-ts

test-sdk-py:
	npm run test:sdk-py

test-cli:
	npm run test:cli

test-server:
	npm run test:server

test-e2e:
	npm run test:e2e

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
