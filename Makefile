.PHONY: all build test test-contracts test-sdk-ts test-sdk-py test-e2e fmt fmt-check lint clean deploy-dry-run

all: build test lint

build:
	forge build --sizes

test: test-contracts test-sdk-ts test-sdk-py test-e2e

test-contracts:
	forge test -vvv

test-sdk-ts:
	npm run test:sdk-ts

test-sdk-py:
	npm run test:sdk-py

test-e2e:
	npm run test:e2e

fmt:
	forge fmt

fmt-check:
	forge fmt --check

lint:
	gitleaks detect --config .gitleaks.toml --verbose
	./test/gitleaks/allowlist.test.sh

deploy-dry-run:
	PRIVATE_KEY=1 forge script script/DeploySandbox.s.sol:DeploySandbox --chain-id 84532

clean:
	forge clean
