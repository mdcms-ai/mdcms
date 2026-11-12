---
"@mdcms/studio": patch
---

Studio signs in through a redirect to the MDCMS server and sends its session in the X-MDCMS-Session header, so sign-in works in browsers that block third-party cookies.
