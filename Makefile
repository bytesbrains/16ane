.PHONY: all build test fmt fmt-check lint clean deploy-dry-run

all: build test lint

build:
	forge build --sizes

test:
	forge test -vvv

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
