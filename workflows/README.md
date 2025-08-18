# Reusable Workflows

This directory contains reusable workflows that are called by other repositories in the organization.

## Important Note

The workflows in `.github/workflows/` (except `validate.yml`) are **reusable workflows** that:
- Use `workflow_call:` as their only trigger
- Cannot be run directly on this repository
- Are designed to be called by other repositories

## Workflow Files

- `composer-package-ci.yml` - CI for Composer packages
- `composer-package-release.yml` - Release process for Composer packages  
- `npm-package-ci.yml` - CI for npm packages
- `npm-package-release.yml` - Release process for npm packages
- `wp-plugin-ci.yml` - CI for WordPress plugins
- `wp-plugin-release.yml` - Release process for WordPress plugins
- `validate.yml` - Validates the syntax and structure of reusable workflows (runs on this repo)

## Usage

These workflows are called from other repositories like:

```yaml
jobs:
  ci:
    uses: builtnorth/.github/.github/workflows/wp-plugin-ci.yml@main
    secrets:
      POLARIS_PLUGIN_GITHUB_TOKEN: ${{ secrets.POLARIS_PLUGIN_GITHUB_TOKEN }}
```