#!/bin/bash

# Compiles the protobuf definition to Javascript

set -e
docker run --rm -v `pwd`:/repo --user $(id -u):$(id -g) gwihlidal/protoc:1.0 -I/repo --js_out=import_style=commonjs,binary:/repo/src /repo/inorbit.proto