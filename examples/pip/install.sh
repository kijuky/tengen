#!/bin/sh


# will install requests@2.32.3
PIP_CONFIG_FILE=pip.conf pip install -r requirements.txt --target ./vendor --no-cache-dir
