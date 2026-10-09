/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Produced by `npm run generate:provider-catalog`
 * (scripts/generate-provider-catalog.ts), which:
 *   1. enumerates the official providers from scripts/lib/v1-stages.ts;
 *   2. inspects each built package with the exact artifact-fingerprint rule
 *      the trust loader uses (runtime/providers/inspect.ts, bundled and
 *      reused, never re-implemented);
 *   3. imports each built artifact at build time to read its real manifest;
 *   4. writes this sorted, data-only catalog.
 *
 * `resolvedRoot` is repository-relative on purpose (for example
 * `packages/provider-bluesky`), so the artifact embeds no absolute path and
 * survives a moved checkout. runtime/local/composition.ts derives the
 * repository root from the CLI package root and resolves each entry there.
 *
 * Verify with `npm run check:provider-catalog` after building the five
 * provider packages. This is build-time data: provider packages are never
 * imported at CLI runtime or during a request.
 */
import type { BuiltinProviderCatalogEntry } from "../types.js";

export const BUILTIN_PROVIDER_CATALOG: readonly BuiltinProviderCatalogEntry[] = [
  {
    "provider": "bluesky",
    "packageName": "@syndroo/provider-bluesky",
    "resolvedRoot": "packages/provider-bluesky",
    "artifactFingerprint": "cf962c1d249667ba9afec02bc7de5f4f68814457f6fc6b1598f9eca24b317565",
    "manifest": {
      "apiVersion": 1,
      "declaredCapabilities": [
        "text"
      ],
      "egress": {
        "fixedOrigins": [
          "https://bsky.social"
        ]
      },
      "id": "bluesky",
      "name": "Bluesky",
      "schemas": {
        "connectOptions": {
          "additionalProperties": false,
          "type": "object"
        },
        "content": {
          "additionalProperties": false,
          "properties": {
            "text": {
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        },
        "credentialInput": {
          "additionalProperties": false,
          "properties": {
            "identifier": {
              "minLength": 1,
              "type": "string"
            },
            "password": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "identifier",
            "password"
          ],
          "type": "object"
        },
        "publishOptions": {
          "additionalProperties": false,
          "type": "object"
        }
      },
      "version": "0.7.0-rc.1"
    }
  },
  {
    "provider": "devto",
    "packageName": "@syndroo/provider-devto",
    "resolvedRoot": "packages/provider-devto",
    "artifactFingerprint": "bcdece7015b1b55bebfd4d959d34b4b094dba1a9b2bec24d4c5d964176e01e99",
    "manifest": {
      "apiVersion": 1,
      "declaredCapabilities": [
        "article"
      ],
      "egress": {
        "fixedOrigins": [
          "https://dev.to"
        ]
      },
      "id": "devto",
      "name": "DEV.to",
      "schemas": {
        "connectOptions": {
          "additionalProperties": false,
          "type": "object"
        },
        "content": {
          "additionalProperties": false,
          "properties": {
            "text": {
              "type": "string"
            }
          },
          "type": "object"
        },
        "credentialInput": {
          "additionalProperties": false,
          "properties": {
            "apiKey": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "apiKey"
          ],
          "type": "object"
        },
        "publishOptions": {
          "additionalProperties": false,
          "properties": {
            "body_markdown": {
              "minLength": 1,
              "type": "string"
            },
            "canonical_url": {
              "minLength": 1,
              "type": "string"
            },
            "description": {
              "minLength": 1,
              "type": "string"
            },
            "published": {
              "type": "boolean"
            },
            "tags": {
              "items": {
                "minLength": 1,
                "type": "string"
              },
              "type": "array"
            },
            "title": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "title",
            "body_markdown"
          ],
          "type": "object"
        }
      },
      "version": "0.7.0-rc.1"
    }
  },
  {
    "provider": "linkedin",
    "packageName": "@syndroo/provider-linkedin",
    "resolvedRoot": "packages/provider-linkedin",
    "artifactFingerprint": "5273e4a4a9ed3674f8e37ffb3b762d517d86b44d7467b7ebafada8552c258a46",
    "manifest": {
      "apiVersion": 1,
      "declaredCapabilities": [
        "text"
      ],
      "egress": {
        "fixedOrigins": [
          "https://www.linkedin.com",
          "https://api.linkedin.com"
        ]
      },
      "id": "linkedin",
      "name": "LinkedIn",
      "schemas": {
        "connectOptions": {
          "additionalProperties": false,
          "properties": {
            "clientId": {
              "minLength": 1,
              "type": "string"
            },
            "clientSecret": {
              "minLength": 1,
              "type": "string"
            },
            "redirectUri": {
              "minLength": 1,
              "type": "string"
            },
            "scopes": {
              "items": {
                "minLength": 1,
                "type": "string"
              },
              "minItems": 1,
              "type": "array"
            }
          },
          "required": [
            "redirectUri"
          ],
          "type": "object"
        },
        "content": {
          "additionalProperties": false,
          "properties": {
            "text": {
              "minLength": 1,
              "type": "string"
            }
          },
          "type": "object"
        },
        "credentialInput": {
          "additionalProperties": false,
          "properties": {
            "client_id": {
              "minLength": 1,
              "type": "string"
            },
            "client_secret": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "client_id",
            "client_secret"
          ],
          "type": "object"
        },
        "publishOptions": {
          "additionalProperties": false,
          "properties": {
            "author": {
              "enum": [
                "member"
              ],
              "type": "string"
            },
            "commentary": {
              "minLength": 1,
              "type": "string"
            },
            "distribution": {
              "type": "object"
            },
            "linkedinVersion": {
              "const": "202601",
              "type": "string"
            },
            "visibility": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "commentary",
            "visibility"
          ],
          "type": "object"
        }
      },
      "version": "0.7.0-rc.1"
    }
  },
  {
    "provider": "mastodon",
    "packageName": "@syndroo/provider-mastodon",
    "resolvedRoot": "packages/provider-mastodon",
    "artifactFingerprint": "0b4e50052b6da819c302912c2a2596b8b2a036cb79147f7797a57841f5951271",
    "manifest": {
      "apiVersion": 1,
      "declaredCapabilities": [
        "text"
      ],
      "egress": {
        "federated": true,
        "fixedOrigins": []
      },
      "id": "mastodon",
      "name": "Mastodon",
      "schemas": {
        "connectOptions": {
          "additionalProperties": false,
          "properties": {
            "clientId": {
              "minLength": 1,
              "type": "string"
            },
            "clientSecret": {
              "minLength": 1,
              "type": "string"
            },
            "instance": {
              "minLength": 1,
              "pattern": "^https://[^\\s]+$",
              "type": "string"
            },
            "redirectUri": {
              "minLength": 1,
              "type": "string"
            },
            "scopes": {
              "items": {
                "minLength": 1,
                "type": "string"
              },
              "minItems": 1,
              "type": "array"
            }
          },
          "required": [
            "instance",
            "redirectUri",
            "scopes"
          ],
          "type": "object"
        },
        "content": {
          "additionalProperties": false,
          "properties": {
            "text": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        },
        "credentialInput": {
          "additionalProperties": false,
          "type": "object"
        },
        "publishOptions": {
          "additionalProperties": false,
          "properties": {
            "visibility": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "visibility"
          ],
          "type": "object"
        }
      },
      "version": "0.7.0-rc.1"
    }
  },
  {
    "provider": "threads",
    "packageName": "@syndroo/provider-threads",
    "resolvedRoot": "packages/provider-threads",
    "artifactFingerprint": "ba4db21a8c6a87aaf322d4169a3ac7483f0aaeb56eee0ee12785a6e0aa4fe989",
    "manifest": {
      "apiVersion": 1,
      "declaredCapabilities": [
        "text"
      ],
      "egress": {
        "fixedOrigins": [
          "https://www.threads.net",
          "https://graph.threads.net"
        ]
      },
      "id": "threads",
      "name": "Threads",
      "schemas": {
        "connectOptions": {
          "additionalProperties": false,
          "properties": {
            "apiHost": {
              "minLength": 1,
              "type": "string"
            },
            "authorizationHost": {
              "minLength": 1,
              "type": "string"
            },
            "clientId": {
              "minLength": 1,
              "type": "string"
            },
            "clientSecret": {
              "minLength": 1,
              "type": "string"
            },
            "redirectUri": {
              "minLength": 1,
              "type": "string"
            },
            "scopes": {
              "items": {
                "minLength": 1,
                "type": "string"
              },
              "minItems": 1,
              "type": "array"
            }
          },
          "required": [
            "redirectUri"
          ],
          "type": "object"
        },
        "content": {
          "additionalProperties": false,
          "properties": {
            "text": {
              "minLength": 1,
              "type": "string"
            }
          },
          "type": "object"
        },
        "credentialInput": {
          "additionalProperties": false,
          "properties": {
            "client_id": {
              "minLength": 1,
              "type": "string"
            },
            "client_secret": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "client_id",
            "client_secret"
          ],
          "type": "object"
        },
        "publishOptions": {
          "additionalProperties": false,
          "properties": {
            "text": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        }
      },
      "version": "0.7.0-rc.1"
    }
  }
];
