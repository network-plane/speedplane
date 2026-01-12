ESBUILD ?= esbuild
GO      ?= go

WEB_SRC     := web/src
WEB_DIST    := web/dist
JS_ENTRY    := $(WEB_SRC)/main.ts
JS_BUNDLE   := $(WEB_DIST)/main.js

BIN_NAME    := speedplane
CMD_DIR     := ./

.PHONY: all build frontend backend clean clean-frontend

all: build

build: frontend backend

frontend: $(JS_BUNDLE) $(WEB_DIST)/index.html

$(JS_BUNDLE): $(JS_ENTRY)
	mkdir -p $(WEB_DIST)
	$(ESBUILD) $(JS_ENTRY) --bundle --outfile=$(JS_BUNDLE) --sourcemap

$(WEB_DIST)/index.html: $(WEB_SRC)/index.html
	mkdir -p $(WEB_DIST)
	cp $(WEB_SRC)/index.html $(WEB_DIST)/

backend:
	$(GO) build -o $(BIN_NAME) .

clean-frontend:
	rm -rf $(WEB_DIST)

clean: clean-frontend
	rm -f $(BIN_NAME)
