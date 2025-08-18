# GitHub Configuration

GitHub configuration and workflow templates for project repositories.

## Overview

This repository contains:
- Reusable workflow templates
- GitHub Actions configurations
- Default community health files
- Shared configuration

## Workflow Types

### CI (Continuous Integration)
- **Purpose**: Automated testing and quality checks on pull requests
- **Triggers**: Pull requests to main branch, manual dispatch
- **Actions**: Runs test suites, code linting, and build validation

### Release
- **Purpose**: Build and package plugins/packages for distribution
- **Triggers**: Manual workflow dispatch with version input
- **Actions**: Creates production builds, generates release artifacts, and publishes GitHub releases
- **Options**: Supports both standard releases and pre-releases

### Tests
- **Purpose**: Comprehensive test suite execution
- **Triggers**: Pull requests, manual dispatch
- **Actions**: Runs unit tests, integration tests, and code coverage analysis

### Scheduled Tests
- **Purpose**: Regular compatibility and dependency checks
- **Triggers**: Weekly schedule (Mondays at 9:00 AM UTC), manual dispatch
- **Actions**: 
  - WordPress compatibility testing across multiple versions
  - PHP version compatibility matrix testing
  - Dependency update monitoring
  - Automatic issue creation on test failures

## Usage

Workflows are configured per repository and can be triggered through GitHub Actions interface or automatically based on configured events.