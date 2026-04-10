#!/bin/sh

go mod init example.com/mod

# will install github.com/gin-gonic/gin@1.10.0
GOENV=$(pwd)/go.env go get github.com/gin-gonic/gin
