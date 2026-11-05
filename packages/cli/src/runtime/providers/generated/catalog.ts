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
    "artifactFingerprint": "88afdb8aba0bc80ba1929909cd79ecaeebc46d9bb140c1cd87c1734213a28977",
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
      "version": "0.8.0"
    }
  },
  {
    "provider": "devto",
    "packageName": "@syndroo/provider-devto",
    "resolvedRoot": "packages/provider-devto",
    "artifactFingerprint": "aec7e75b657274c6ab9c509c7cddb5b259a6f35c74821cd6c4c7d38bdf1bf69c",
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
      "version": "0.8.0"
    }
  },
  {
    "provider": "linkedin",
    "packageName": "@syndroo/provider-linkedin",
    "resolvedRoot": "packages/provider-linkedin",
    "artifactFingerprint": "0d78954374ac898e19bef16550cb578e3e2ccc05d93c2e9b237a9e3a1177926d",
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
      "version": "0.8.0"
    }
  },
  {
    "provider": "mastodon",
    "packageName": "@syndroo/provider-mastodon",
    "resolvedRoot": "packages/provider-mastodon",
    "artifactFingerprint": "d53fa7b96f6463da98592571bb75815d335e2bf950e00233469306a42e30717c",
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
      "version": "0.8.0"
    }
  },
  {
    "provider": "threads",
    "packageName": "@syndroo/provider-threads",
    "resolvedRoot": "packages/provider-threads",
    "artifactFingerprint": "bb3d841a776f4bb2b84287fec9bfbf88076d620642513a24c73da05adc2f1a68",
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
      "version": "0.8.0"
    }
  }
];
