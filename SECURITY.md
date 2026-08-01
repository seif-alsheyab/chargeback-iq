# Security Policy

## Overview

Chargeback-IQ is a dispute and chargeback operations platform designed around
financial workflow integrity, lifecycle enforcement, evidence control, audit
logging, and compliance monitoring.

Security issues are treated as a priority because the system handles workflows
related to financial operations.

---

## Reporting a Vulnerability

Do not create a public GitHub issue for security vulnerabilities.

Please report security concerns privately to the repository owner.

Include:

- Description of the vulnerability
- Steps required to reproduce it
- Potential impact
- Suggested remediation if available

---

## Scope

Security reports may include:

- Authentication issues
- Authorization bypasses
- Data exposure
- Injection vulnerabilities
- Secret leakage
- Integrity failures
- Audit trail manipulation
- Security configuration problems

---

## Out of Scope

The following are generally not considered security vulnerabilities:

- Missing documentation
- Feature requests
- General bugs without security impact
- Issues requiring unrealistic user interaction

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| main branch | Yes |

---

## Security Practices

This repository applies:

- Protected main branch
- Pull request review requirements
- CODEOWNERS approval
- GitHub Actions CI validation
- Secret detection checks
- Local pre-commit security checks
- Environment variable separation

---

## Responsible Disclosure

Researchers are encouraged to provide enough information to reproduce and
validate reported issues.

Security fixes may be released after the issue has been investigated and
remediated.
