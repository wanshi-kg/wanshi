#!/bin/bash
echo "Testing Gmail API integration..."
(sleep 3; kill %1) & npm run start 2>&1
