# Built North Centralized GitHub Workflows

This directory contains reusable GitHub Actions workflows for all Built North projects. These workflows provide standardized CI/CD pipelines for WordPress plugins, Composer packages, and NPM packages.

## 📁 Directory Structure

```
workflows/
├── wp-plugin-ci.yml           # WordPress plugin CI workflow
├── wp-plugin-release.yml      # WordPress plugin release workflow
├── composer-package-ci.yml    # Composer package CI workflow
├── composer-package-release.yml # Composer package release workflow
├── npm-package-ci.yml         # NPM package CI workflow
├── npm-package-release.yml    # NPM package release workflow
└── shared/                    # Shared composite actions
    ├── setup-php/action.yml
    ├── setup-node/action.yml
    └── setup-wordpress/action.yml
```

## 🚀 Quick Start

To use these workflows in your repository, create a `.github/workflows` directory and add workflow files that call these reusable workflows.

### WordPress Plugin Example

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    uses: builtnorth/.github/workflows/wp-plugin-ci.yml@main
    secrets:
      POLARIS_PLUGIN_GITHUB_TOKEN: ${{ secrets.POLARIS_PLUGIN_GITHUB_TOKEN }}
```

```yaml
# .github/workflows/release.yml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Release version (e.g., 1.2.0)'
        required: true
        type: string

jobs:
  release:
    uses: builtnorth/.github/workflows/wp-plugin-release.yml@main
    with:
      version: ${{ inputs.version }}
    secrets:
      POLARIS_PLUGIN_GITHUB_TOKEN: ${{ secrets.POLARIS_PLUGIN_GITHUB_TOKEN }}
```

### Composer Package Example

```yaml
# .github/workflows/tests.yml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    uses: builtnorth/.github/workflows/composer-package-ci.yml@main
```

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  release:
    uses: builtnorth/.github/workflows/composer-package-release.yml@main
```

### NPM Package Example

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    uses: builtnorth/.github/workflows/npm-package-ci.yml@main
    secrets:
      POLARIS_PLUGIN_GITHUB_TOKEN: ${{ secrets.POLARIS_PLUGIN_GITHUB_TOKEN }}
```

## 📋 Workflow Reference

### WordPress Plugin CI (`wp-plugin-ci.yml`)

Runs comprehensive CI checks for WordPress plugins.

**Inputs:**
- `plugin-slug` - Plugin directory name (defaults to repository name)
- `php-versions` - PHP versions to test (default: `["8.1", "8.2"]`)
- `wordpress-versions` - WordPress versions to test (default: `["6.6", "latest"]`)
- `node-version` - Node version for assets (default: `20`)
- `run-phpcs` - Run PHP CodeSniffer (default: `true`)
- `run-php-compatibility` - Run PHP compatibility check (default: `true`)
- `run-unit-tests` - Run PHPUnit tests (default: `true`)
- `run-security-check` - Run security audit (default: `true`)
- `run-release-check` - Check release readiness on PRs (default: `true`)

**Jobs:**
- PHP linting
- PHPUnit tests with wp-env
- PHP CodeSniffer
- PHP compatibility check
- Security audit
- Release readiness check (PRs only)

### WordPress Plugin Release (`wp-plugin-release.yml`)

Creates a GitHub release with plugin ZIP file.

**Inputs:**
- `version` - Release version (e.g., `1.2.0`)
- `prerelease` - Mark as pre-release (default: `false`)

**Features:**
- Updates version in plugin files
- Creates git tag
- Builds production-ready plugin ZIP
- Generates changelog from commits
- Creates GitHub release

### Composer Package CI (`composer-package-ci.yml`)

Runs tests and quality checks for Composer packages.

**Inputs:**
- `package-name` - Package name (defaults to repository name)
- `php-versions` - PHP versions to test (default: `["8.1", "8.2", "8.3", "8.4"]`)
- `run-coverage` - Run code coverage (default: `true`)
- `run-phpcs` - Run PHPCS (default: `true`)
- `run-phpcompat` - Run PHP compatibility (default: `true`)
- `run-security-check` - Run security audit (default: `true`)
- `coverage-php-version` - PHP version for coverage (default: `8.3`)

**Jobs:**
- PHPUnit tests across PHP versions
- Code coverage with Codecov
- PHPCS coding standards
- PHP compatibility check
- Security audit

### Composer Package Release (`composer-package-release.yml`)

Creates releases for Composer packages.

**Inputs:**
- `version` - Release version
- `prerelease` - Mark as pre-release (default: `false`)
- `package-name` - Package name for archive
- `package-display-name` - Display name
- `composer-namespace` - Composer namespace

**Features:**
- Tag-based or manual releases
- Version-less composer.json (uses git tags)
- Release archive creation
- Changelog generation
- GitHub release creation

### NPM Package CI (`npm-package-ci.yml`)

CI pipeline for NPM packages with workspace support.

**Inputs:**
- `package-name` - Package name (defaults to repository name)
- `node-versions` - Node versions to test (default: `["18", "20", "22"]`)
- `build-command` - Build command (default: `build`)
- `test-command` - Test command (default: `test`)
- `lint-command` - Lint command (default: `lint`)
- `type-check-command` - Type check command
- `run-tests` - Run tests (default: `true`)
- `run-lint` - Run linting (default: `true`)
- `run-build` - Run build (default: `true`)
- `run-type-check` - Run type checking (default: `false`)
- `use-workspace` - Use npm workspace (default: `true`)

**Jobs:**
- Tests across Node versions
- Linting
- Type checking (optional)
- Build verification

### NPM Package Release (`npm-package-release.yml`)

Creates releases and publishes NPM packages.

**Inputs:**
- `version` - Release version
- `prerelease` - Mark as pre-release (default: `false`)
- `package-name` - Package name
- `node-version` - Node version (default: `22`)
- `publish-to-npm` - Publish to npmjs.org (default: `false`)
- `publish-to-github` - Publish to GitHub Packages (default: `true`)
- `use-workspace` - Use npm workspace (default: `true`)

**Features:**
- Workspace-aware builds
- GitHub Packages publishing
- Optional npm registry publishing
- Release archive creation
- GitHub release creation

## 🔧 Composite Actions

### setup-php

Standardized PHP setup with caching.

```yaml
- uses: builtnorth/.github/workflows/shared/setup-php@main
  with:
    php-version: '8.2'
    coverage: 'xdebug'
```

### setup-node

Standardized Node.js setup with caching.

```yaml
- uses: builtnorth/.github/workflows/shared/setup-node@main
  with:
    node-version: '20'
```

### setup-wordpress

WordPress testing environment setup.

```yaml
- uses: builtnorth/.github/workflows/shared/setup-wordpress@main
  with:
    wordpress-version: 'latest'
    plugin-slug: 'my-plugin'
```

## 🔐 Required Secrets

### Organization Secrets
- `POLARIS_PLUGIN_GITHUB_TOKEN` - GitHub token with access to private repositories
- `NPM_TOKEN` - NPM registry authentication token (if publishing to npmjs.org)

## 📦 Project Types

### WordPress Plugins
- polaris-blocks
- polaris-directory
- polaris-forms
- polaris-integrations
- polaris-reviews
- polaris-seo

### Composer Packages
- wp-utility
- wp-baseline
- wp-config
- wp-schema
- extended-cpts-extras
- polaris
- builtnorth-coding-standards

### NPM Packages
- wp-admin-dashboard
- wp-blocks
- wp-component-library
- ui-kit
- wp-theme-json-compiler

## 🔄 Migration Guide

### From Individual Workflows

1. **Backup existing workflows** in your repository
2. **Create new workflow files** that call the centralized workflows
3. **Test in a feature branch** before merging
4. **Remove old workflow logic** once confirmed working

### Version Pinning

For stability, you can pin to specific versions:

```yaml
uses: builtnorth/.github/workflows/wp-plugin-ci.yml@v1.0.0
```

Or use the latest from main:

```yaml
uses: builtnorth/.github/workflows/wp-plugin-ci.yml@main
```

## 🐛 Troubleshooting

### Common Issues

**Private repository access:**
Ensure `POLARIS_PLUGIN_GITHUB_TOKEN` secret is set with appropriate permissions.

**Composer dependencies:**
The workflows automatically configure private repository access for Built North packages.

**NPM workspace issues:**
Set `use-workspace: false` if your package doesn't use the monorepo structure.

## 📝 Maintenance

### Updating Workflows

1. Test changes in a single repository first
2. Update the centralized workflow
3. Monitor affected repositories
4. Document any breaking changes

### Adding New Workflows

1. Create the workflow file in `.github/workflows/`
2. Follow existing naming conventions
3. Document inputs and usage
4. Add examples to this README

## 📄 License

Internal use only - Built North proprietary.