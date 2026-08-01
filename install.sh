#!/bin/bash
set -e

# OB Agents CLI Installation Script
echo "Installing OB Agents CLI..."

if ! command -v npm &> /dev/null
then
    echo "npm could not be found. Please install Node.js and npm first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

echo "Installing globally via npm..."
npm install -g obagents

echo ""
echo "========================================="
echo "✅ OB Agents CLI installed successfully! "
echo "Run 'ob --help' to get started."
echo "========================================="
