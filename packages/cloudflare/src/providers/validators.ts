// @ts-nocheck
// Standalone Ajv2020 output; no runtime schema compiler.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// ../../node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "../../node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// ../../validators.js
var bluesky_connectOptions = validate20;
function validate20(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      for (const key0 in data) {
        validate20.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
        return false;
        break;
      }
    } else {
      validate20.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var bluesky_content = validate21;
function validate21(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate21.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.text === void 0 && (missing0 = "text")) {
        validate21.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "text")) {
            validate21.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.text !== void 0) {
            if (typeof data.text !== "string") {
              validate21.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
        }
      }
    } else {
      validate21.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate21.errors = vErrors;
  return errors === 0;
}
validate21.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var bluesky_credentialInput = validate22;
var func1 = require_ucs2length().default;
function validate22(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate22.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.identifier === void 0 && (missing0 = "identifier") || data.password === void 0 && (missing0 = "password")) {
        validate22.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "identifier" || key0 === "password")) {
            validate22.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.identifier !== void 0) {
            let data0 = data.identifier;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate22.errors = [{ instancePath: instancePath + "/identifier", schemaPath: "#/properties/identifier/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate22.errors = [{ instancePath: instancePath + "/identifier", schemaPath: "#/properties/identifier/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.password !== void 0) {
              let data1 = data.password;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate22.errors = [{ instancePath: instancePath + "/password", schemaPath: "#/properties/password/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate22.errors = [{ instancePath: instancePath + "/password", schemaPath: "#/properties/password/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate22.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate22.errors = vErrors;
  return errors === 0;
}
validate22.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var bluesky_publishOptions = validate23;
function validate23(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate23.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      for (const key0 in data) {
        validate23.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
        return false;
        break;
      }
    } else {
      validate23.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate23.errors = vErrors;
  return errors === 0;
}
validate23.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var devto_connectOptions = validate24;
function validate24(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate24.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      for (const key0 in data) {
        validate24.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
        return false;
        break;
      }
    } else {
      validate24.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate24.errors = vErrors;
  return errors === 0;
}
validate24.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var devto_content = validate25;
function validate25(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate25.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      const _errs1 = errors;
      for (const key0 in data) {
        if (!(key0 === "text")) {
          validate25.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
          return false;
          break;
        }
      }
      if (_errs1 === errors) {
        if (data.text !== void 0) {
          if (typeof data.text !== "string") {
            validate25.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
            return false;
          }
        }
      }
    } else {
      validate25.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate25.errors = vErrors;
  return errors === 0;
}
validate25.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var devto_credentialInput = validate26;
function validate26(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate26.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.apiKey === void 0 && (missing0 = "apiKey")) {
        validate26.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "apiKey")) {
            validate26.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.apiKey !== void 0) {
            let data0 = data.apiKey;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate26.errors = [{ instancePath: instancePath + "/apiKey", schemaPath: "#/properties/apiKey/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate26.errors = [{ instancePath: instancePath + "/apiKey", schemaPath: "#/properties/apiKey/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
          }
        }
      }
    } else {
      validate26.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate26.errors = vErrors;
  return errors === 0;
}
validate26.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var devto_publishOptions = validate27;
function validate27(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate27.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.title === void 0 && (missing0 = "title") || data.body_markdown === void 0 && (missing0 = "body_markdown")) {
        validate27.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "body_markdown" || key0 === "canonical_url" || key0 === "description" || key0 === "published" || key0 === "tags" || key0 === "title")) {
            validate27.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.body_markdown !== void 0) {
            let data0 = data.body_markdown;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate27.errors = [{ instancePath: instancePath + "/body_markdown", schemaPath: "#/properties/body_markdown/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate27.errors = [{ instancePath: instancePath + "/body_markdown", schemaPath: "#/properties/body_markdown/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.canonical_url !== void 0) {
              let data1 = data.canonical_url;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate27.errors = [{ instancePath: instancePath + "/canonical_url", schemaPath: "#/properties/canonical_url/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate27.errors = [{ instancePath: instancePath + "/canonical_url", schemaPath: "#/properties/canonical_url/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.description !== void 0) {
                let data2 = data.description;
                const _errs6 = errors;
                if (errors === _errs6) {
                  if (typeof data2 === "string") {
                    if (func1(data2) < 1) {
                      validate27.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    }
                  } else {
                    validate27.errors = [{ instancePath: instancePath + "/description", schemaPath: "#/properties/description/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.published !== void 0) {
                  const _errs8 = errors;
                  if (typeof data.published !== "boolean") {
                    validate27.errors = [{ instancePath: instancePath + "/published", schemaPath: "#/properties/published/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" }];
                    return false;
                  }
                  var valid0 = _errs8 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.tags !== void 0) {
                    let data4 = data.tags;
                    const _errs10 = errors;
                    if (errors === _errs10) {
                      if (Array.isArray(data4)) {
                        var valid1 = true;
                        const len0 = data4.length;
                        for (let i0 = 0; i0 < len0; i0++) {
                          let data5 = data4[i0];
                          const _errs12 = errors;
                          if (errors === _errs12) {
                            if (typeof data5 === "string") {
                              if (func1(data5) < 1) {
                                validate27.errors = [{ instancePath: instancePath + "/tags/" + i0, schemaPath: "#/properties/tags/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                return false;
                              }
                            } else {
                              validate27.errors = [{ instancePath: instancePath + "/tags/" + i0, schemaPath: "#/properties/tags/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                              return false;
                            }
                          }
                          var valid1 = _errs12 === errors;
                          if (!valid1) {
                            break;
                          }
                        }
                      } else {
                        validate27.errors = [{ instancePath: instancePath + "/tags", schemaPath: "#/properties/tags/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                        return false;
                      }
                    }
                    var valid0 = _errs10 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.title !== void 0) {
                      let data6 = data.title;
                      const _errs14 = errors;
                      if (errors === _errs14) {
                        if (typeof data6 === "string") {
                          if (func1(data6) < 1) {
                            validate27.errors = [{ instancePath: instancePath + "/title", schemaPath: "#/properties/title/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                            return false;
                          }
                        } else {
                          validate27.errors = [{ instancePath: instancePath + "/title", schemaPath: "#/properties/title/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                          return false;
                        }
                      }
                      var valid0 = _errs14 === errors;
                    } else {
                      var valid0 = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate27.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate27.errors = vErrors;
  return errors === 0;
}
validate27.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var linkedin_connectOptions = validate28;
function validate28(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate28.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.redirectUri === void 0 && (missing0 = "redirectUri")) {
        validate28.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "clientId" || key0 === "clientSecret" || key0 === "redirectUri" || key0 === "scopes")) {
            validate28.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.clientId !== void 0) {
            let data0 = data.clientId;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate28.errors = [{ instancePath: instancePath + "/clientId", schemaPath: "#/properties/clientId/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate28.errors = [{ instancePath: instancePath + "/clientId", schemaPath: "#/properties/clientId/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.clientSecret !== void 0) {
              let data1 = data.clientSecret;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate28.errors = [{ instancePath: instancePath + "/clientSecret", schemaPath: "#/properties/clientSecret/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate28.errors = [{ instancePath: instancePath + "/clientSecret", schemaPath: "#/properties/clientSecret/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.redirectUri !== void 0) {
                let data2 = data.redirectUri;
                const _errs6 = errors;
                if (errors === _errs6) {
                  if (typeof data2 === "string") {
                    if (func1(data2) < 1) {
                      validate28.errors = [{ instancePath: instancePath + "/redirectUri", schemaPath: "#/properties/redirectUri/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    }
                  } else {
                    validate28.errors = [{ instancePath: instancePath + "/redirectUri", schemaPath: "#/properties/redirectUri/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.scopes !== void 0) {
                  let data3 = data.scopes;
                  const _errs8 = errors;
                  if (errors === _errs8) {
                    if (Array.isArray(data3)) {
                      if (data3.length < 1) {
                        validate28.errors = [{ instancePath: instancePath + "/scopes", schemaPath: "#/properties/scopes/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" }];
                        return false;
                      } else {
                        var valid1 = true;
                        const len0 = data3.length;
                        for (let i0 = 0; i0 < len0; i0++) {
                          let data4 = data3[i0];
                          const _errs10 = errors;
                          if (errors === _errs10) {
                            if (typeof data4 === "string") {
                              if (func1(data4) < 1) {
                                validate28.errors = [{ instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/properties/scopes/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                return false;
                              }
                            } else {
                              validate28.errors = [{ instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/properties/scopes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                              return false;
                            }
                          }
                          var valid1 = _errs10 === errors;
                          if (!valid1) {
                            break;
                          }
                        }
                      }
                    } else {
                      validate28.errors = [{ instancePath: instancePath + "/scopes", schemaPath: "#/properties/scopes/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                      return false;
                    }
                  }
                  var valid0 = _errs8 === errors;
                } else {
                  var valid0 = true;
                }
              }
            }
          }
        }
      }
    } else {
      validate28.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate28.errors = vErrors;
  return errors === 0;
}
validate28.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var linkedin_content = validate29;
function validate29(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate29.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      const _errs1 = errors;
      for (const key0 in data) {
        if (!(key0 === "text")) {
          validate29.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
          return false;
          break;
        }
      }
      if (_errs1 === errors) {
        if (data.text !== void 0) {
          let data0 = data.text;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (typeof data0 === "string") {
              if (func1(data0) < 1) {
                validate29.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                return false;
              }
            } else {
              validate29.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
        }
      }
    } else {
      validate29.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var linkedin_credentialInput = validate30;
function validate30(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate30.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.client_id === void 0 && (missing0 = "client_id") || data.client_secret === void 0 && (missing0 = "client_secret")) {
        validate30.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "client_id" || key0 === "client_secret")) {
            validate30.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.client_id !== void 0) {
            let data0 = data.client_id;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate30.errors = [{ instancePath: instancePath + "/client_id", schemaPath: "#/properties/client_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate30.errors = [{ instancePath: instancePath + "/client_id", schemaPath: "#/properties/client_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.client_secret !== void 0) {
              let data1 = data.client_secret;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate30.errors = [{ instancePath: instancePath + "/client_secret", schemaPath: "#/properties/client_secret/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate30.errors = [{ instancePath: instancePath + "/client_secret", schemaPath: "#/properties/client_secret/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate30.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate30.errors = vErrors;
  return errors === 0;
}
validate30.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var linkedin_publishOptions = validate31;
var schema42 = { "additionalProperties": false, "properties": { "author": { "enum": ["member"], "type": "string" }, "commentary": { "minLength": 1, "type": "string" }, "distribution": { "type": "object" }, "linkedinVersion": { "const": "202601", "type": "string" }, "visibility": { "minLength": 1, "type": "string" } }, "required": ["commentary", "visibility"], "type": "object", "$id": "https://syndroo.invalid/worker/linkedin/publishOptions" };
function validate31(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate31.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.commentary === void 0 && (missing0 = "commentary") || data.visibility === void 0 && (missing0 = "visibility")) {
        validate31.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "author" || key0 === "commentary" || key0 === "distribution" || key0 === "linkedinVersion" || key0 === "visibility")) {
            validate31.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.author !== void 0) {
            let data0 = data.author;
            const _errs2 = errors;
            if (typeof data0 !== "string") {
              validate31.errors = [{ instancePath: instancePath + "/author", schemaPath: "#/properties/author/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
            if (!(data0 === "member")) {
              validate31.errors = [{ instancePath: instancePath + "/author", schemaPath: "#/properties/author/enum", keyword: "enum", params: { allowedValues: schema42.properties.author.enum }, message: "must be equal to one of the allowed values" }];
              return false;
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.commentary !== void 0) {
              let data1 = data.commentary;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate31.errors = [{ instancePath: instancePath + "/commentary", schemaPath: "#/properties/commentary/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate31.errors = [{ instancePath: instancePath + "/commentary", schemaPath: "#/properties/commentary/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.distribution !== void 0) {
                let data2 = data.distribution;
                const _errs6 = errors;
                if (!(data2 && typeof data2 == "object" && !Array.isArray(data2))) {
                  validate31.errors = [{ instancePath: instancePath + "/distribution", schemaPath: "#/properties/distribution/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
                  return false;
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.linkedinVersion !== void 0) {
                  let data3 = data.linkedinVersion;
                  const _errs8 = errors;
                  if (typeof data3 !== "string") {
                    validate31.errors = [{ instancePath: instancePath + "/linkedinVersion", schemaPath: "#/properties/linkedinVersion/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                  if ("202601" !== data3) {
                    validate31.errors = [{ instancePath: instancePath + "/linkedinVersion", schemaPath: "#/properties/linkedinVersion/const", keyword: "const", params: { allowedValue: "202601" }, message: "must be equal to constant" }];
                    return false;
                  }
                  var valid0 = _errs8 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.visibility !== void 0) {
                    let data4 = data.visibility;
                    const _errs10 = errors;
                    if (errors === _errs10) {
                      if (typeof data4 === "string") {
                        if (func1(data4) < 1) {
                          validate31.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/properties/visibility/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                          return false;
                        }
                      } else {
                        validate31.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/properties/visibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                    }
                    var valid0 = _errs10 === errors;
                  } else {
                    var valid0 = true;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate31.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate31.errors = vErrors;
  return errors === 0;
}
validate31.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var mastodon_connectOptions = validate32;
var pattern4 = new RegExp("^https://[^\\s]+$", "u");
function validate32(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate32.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.instance === void 0 && (missing0 = "instance") || data.redirectUri === void 0 && (missing0 = "redirectUri") || data.scopes === void 0 && (missing0 = "scopes")) {
        validate32.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "clientId" || key0 === "clientSecret" || key0 === "instance" || key0 === "redirectUri" || key0 === "scopes")) {
            validate32.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.clientId !== void 0) {
            let data0 = data.clientId;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate32.errors = [{ instancePath: instancePath + "/clientId", schemaPath: "#/properties/clientId/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate32.errors = [{ instancePath: instancePath + "/clientId", schemaPath: "#/properties/clientId/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.clientSecret !== void 0) {
              let data1 = data.clientSecret;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate32.errors = [{ instancePath: instancePath + "/clientSecret", schemaPath: "#/properties/clientSecret/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate32.errors = [{ instancePath: instancePath + "/clientSecret", schemaPath: "#/properties/clientSecret/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.instance !== void 0) {
                let data2 = data.instance;
                const _errs6 = errors;
                if (errors === _errs6) {
                  if (typeof data2 === "string") {
                    if (func1(data2) < 1) {
                      validate32.errors = [{ instancePath: instancePath + "/instance", schemaPath: "#/properties/instance/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    } else {
                      if (!pattern4.test(data2)) {
                        validate32.errors = [{ instancePath: instancePath + "/instance", schemaPath: "#/properties/instance/pattern", keyword: "pattern", params: { pattern: "^https://[^\\s]+$" }, message: 'must match pattern "^https://[^\\s]+$"' }];
                        return false;
                      }
                    }
                  } else {
                    validate32.errors = [{ instancePath: instancePath + "/instance", schemaPath: "#/properties/instance/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.redirectUri !== void 0) {
                  let data3 = data.redirectUri;
                  const _errs8 = errors;
                  if (errors === _errs8) {
                    if (typeof data3 === "string") {
                      if (func1(data3) < 1) {
                        validate32.errors = [{ instancePath: instancePath + "/redirectUri", schemaPath: "#/properties/redirectUri/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                        return false;
                      }
                    } else {
                      validate32.errors = [{ instancePath: instancePath + "/redirectUri", schemaPath: "#/properties/redirectUri/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                  }
                  var valid0 = _errs8 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.scopes !== void 0) {
                    let data4 = data.scopes;
                    const _errs10 = errors;
                    if (errors === _errs10) {
                      if (Array.isArray(data4)) {
                        if (data4.length < 1) {
                          validate32.errors = [{ instancePath: instancePath + "/scopes", schemaPath: "#/properties/scopes/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" }];
                          return false;
                        } else {
                          var valid1 = true;
                          const len0 = data4.length;
                          for (let i0 = 0; i0 < len0; i0++) {
                            let data5 = data4[i0];
                            const _errs12 = errors;
                            if (errors === _errs12) {
                              if (typeof data5 === "string") {
                                if (func1(data5) < 1) {
                                  validate32.errors = [{ instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/properties/scopes/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                  return false;
                                }
                              } else {
                                validate32.errors = [{ instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/properties/scopes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                return false;
                              }
                            }
                            var valid1 = _errs12 === errors;
                            if (!valid1) {
                              break;
                            }
                          }
                        }
                      } else {
                        validate32.errors = [{ instancePath: instancePath + "/scopes", schemaPath: "#/properties/scopes/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                        return false;
                      }
                    }
                    var valid0 = _errs10 === errors;
                  } else {
                    var valid0 = true;
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate32.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate32.errors = vErrors;
  return errors === 0;
}
validate32.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var mastodon_content = validate33;
function validate33(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate33.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.text === void 0 && (missing0 = "text")) {
        validate33.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "text")) {
            validate33.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.text !== void 0) {
            let data0 = data.text;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate33.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate33.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
          }
        }
      }
    } else {
      validate33.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate33.errors = vErrors;
  return errors === 0;
}
validate33.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var mastodon_credentialInput = validate34;
function validate34(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate34.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      for (const key0 in data) {
        validate34.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
        return false;
        break;
      }
    } else {
      validate34.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate34.errors = vErrors;
  return errors === 0;
}
validate34.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var mastodon_publishOptions = validate35;
function validate35(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate35.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.visibility === void 0 && (missing0 = "visibility")) {
        validate35.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "visibility")) {
            validate35.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.visibility !== void 0) {
            let data0 = data.visibility;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate35.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/properties/visibility/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate35.errors = [{ instancePath: instancePath + "/visibility", schemaPath: "#/properties/visibility/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
          }
        }
      }
    } else {
      validate35.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate35.errors = vErrors;
  return errors === 0;
}
validate35.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var threads_connectOptions = validate36;
function validate36(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate36.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.redirectUri === void 0 && (missing0 = "redirectUri")) {
        validate36.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "apiHost" || key0 === "authorizationHost" || key0 === "clientId" || key0 === "clientSecret" || key0 === "redirectUri" || key0 === "scopes")) {
            validate36.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.apiHost !== void 0) {
            let data0 = data.apiHost;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate36.errors = [{ instancePath: instancePath + "/apiHost", schemaPath: "#/properties/apiHost/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate36.errors = [{ instancePath: instancePath + "/apiHost", schemaPath: "#/properties/apiHost/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.authorizationHost !== void 0) {
              let data1 = data.authorizationHost;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate36.errors = [{ instancePath: instancePath + "/authorizationHost", schemaPath: "#/properties/authorizationHost/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate36.errors = [{ instancePath: instancePath + "/authorizationHost", schemaPath: "#/properties/authorizationHost/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
            if (valid0) {
              if (data.clientId !== void 0) {
                let data2 = data.clientId;
                const _errs6 = errors;
                if (errors === _errs6) {
                  if (typeof data2 === "string") {
                    if (func1(data2) < 1) {
                      validate36.errors = [{ instancePath: instancePath + "/clientId", schemaPath: "#/properties/clientId/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                      return false;
                    }
                  } else {
                    validate36.errors = [{ instancePath: instancePath + "/clientId", schemaPath: "#/properties/clientId/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                    return false;
                  }
                }
                var valid0 = _errs6 === errors;
              } else {
                var valid0 = true;
              }
              if (valid0) {
                if (data.clientSecret !== void 0) {
                  let data3 = data.clientSecret;
                  const _errs8 = errors;
                  if (errors === _errs8) {
                    if (typeof data3 === "string") {
                      if (func1(data3) < 1) {
                        validate36.errors = [{ instancePath: instancePath + "/clientSecret", schemaPath: "#/properties/clientSecret/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                        return false;
                      }
                    } else {
                      validate36.errors = [{ instancePath: instancePath + "/clientSecret", schemaPath: "#/properties/clientSecret/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                      return false;
                    }
                  }
                  var valid0 = _errs8 === errors;
                } else {
                  var valid0 = true;
                }
                if (valid0) {
                  if (data.redirectUri !== void 0) {
                    let data4 = data.redirectUri;
                    const _errs10 = errors;
                    if (errors === _errs10) {
                      if (typeof data4 === "string") {
                        if (func1(data4) < 1) {
                          validate36.errors = [{ instancePath: instancePath + "/redirectUri", schemaPath: "#/properties/redirectUri/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                          return false;
                        }
                      } else {
                        validate36.errors = [{ instancePath: instancePath + "/redirectUri", schemaPath: "#/properties/redirectUri/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                        return false;
                      }
                    }
                    var valid0 = _errs10 === errors;
                  } else {
                    var valid0 = true;
                  }
                  if (valid0) {
                    if (data.scopes !== void 0) {
                      let data5 = data.scopes;
                      const _errs12 = errors;
                      if (errors === _errs12) {
                        if (Array.isArray(data5)) {
                          if (data5.length < 1) {
                            validate36.errors = [{ instancePath: instancePath + "/scopes", schemaPath: "#/properties/scopes/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" }];
                            return false;
                          } else {
                            var valid1 = true;
                            const len0 = data5.length;
                            for (let i0 = 0; i0 < len0; i0++) {
                              let data6 = data5[i0];
                              const _errs14 = errors;
                              if (errors === _errs14) {
                                if (typeof data6 === "string") {
                                  if (func1(data6) < 1) {
                                    validate36.errors = [{ instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/properties/scopes/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                                    return false;
                                  }
                                } else {
                                  validate36.errors = [{ instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/properties/scopes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                                  return false;
                                }
                              }
                              var valid1 = _errs14 === errors;
                              if (!valid1) {
                                break;
                              }
                            }
                          }
                        } else {
                          validate36.errors = [{ instancePath: instancePath + "/scopes", schemaPath: "#/properties/scopes/type", keyword: "type", params: { type: "array" }, message: "must be array" }];
                          return false;
                        }
                      }
                      var valid0 = _errs12 === errors;
                    } else {
                      var valid0 = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } else {
      validate36.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate36.errors = vErrors;
  return errors === 0;
}
validate36.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var threads_content = validate37;
function validate37(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate37.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      const _errs1 = errors;
      for (const key0 in data) {
        if (!(key0 === "text")) {
          validate37.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
          return false;
          break;
        }
      }
      if (_errs1 === errors) {
        if (data.text !== void 0) {
          let data0 = data.text;
          const _errs2 = errors;
          if (errors === _errs2) {
            if (typeof data0 === "string") {
              if (func1(data0) < 1) {
                validate37.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                return false;
              }
            } else {
              validate37.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
              return false;
            }
          }
        }
      }
    } else {
      validate37.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate37.errors = vErrors;
  return errors === 0;
}
validate37.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var threads_credentialInput = validate38;
function validate38(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate38.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.client_id === void 0 && (missing0 = "client_id") || data.client_secret === void 0 && (missing0 = "client_secret")) {
        validate38.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "client_id" || key0 === "client_secret")) {
            validate38.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.client_id !== void 0) {
            let data0 = data.client_id;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate38.errors = [{ instancePath: instancePath + "/client_id", schemaPath: "#/properties/client_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate38.errors = [{ instancePath: instancePath + "/client_id", schemaPath: "#/properties/client_id/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
            var valid0 = _errs2 === errors;
          } else {
            var valid0 = true;
          }
          if (valid0) {
            if (data.client_secret !== void 0) {
              let data1 = data.client_secret;
              const _errs4 = errors;
              if (errors === _errs4) {
                if (typeof data1 === "string") {
                  if (func1(data1) < 1) {
                    validate38.errors = [{ instancePath: instancePath + "/client_secret", schemaPath: "#/properties/client_secret/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                    return false;
                  }
                } else {
                  validate38.errors = [{ instancePath: instancePath + "/client_secret", schemaPath: "#/properties/client_secret/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                  return false;
                }
              }
              var valid0 = _errs4 === errors;
            } else {
              var valid0 = true;
            }
          }
        }
      }
    } else {
      validate38.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate38.errors = vErrors;
  return errors === 0;
}
validate38.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var threads_publishOptions = validate39;
function validate39(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate39.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (errors === 0) {
    if (data && typeof data == "object" && !Array.isArray(data)) {
      let missing0;
      if (data.text === void 0 && (missing0 = "text")) {
        validate39.errors = [{ instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: missing0 }, message: "must have required property '" + missing0 + "'" }];
        return false;
      } else {
        const _errs1 = errors;
        for (const key0 in data) {
          if (!(key0 === "text")) {
            validate39.errors = [{ instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" }];
            return false;
            break;
          }
        }
        if (_errs1 === errors) {
          if (data.text !== void 0) {
            let data0 = data.text;
            const _errs2 = errors;
            if (errors === _errs2) {
              if (typeof data0 === "string") {
                if (func1(data0) < 1) {
                  validate39.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" }];
                  return false;
                }
              } else {
                validate39.errors = [{ instancePath: instancePath + "/text", schemaPath: "#/properties/text/type", keyword: "type", params: { type: "string" }, message: "must be string" }];
                return false;
              }
            }
          }
        }
      }
    } else {
      validate39.errors = [{ instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" }];
      return false;
    }
  }
  validate39.errors = vErrors;
  return errors === 0;
}
validate39.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
export {
  bluesky_connectOptions,
  bluesky_content,
  bluesky_credentialInput,
  bluesky_publishOptions,
  devto_connectOptions,
  devto_content,
  devto_credentialInput,
  devto_publishOptions,
  linkedin_connectOptions,
  linkedin_content,
  linkedin_credentialInput,
  linkedin_publishOptions,
  mastodon_connectOptions,
  mastodon_content,
  mastodon_credentialInput,
  mastodon_publishOptions,
  threads_connectOptions,
  threads_content,
  threads_credentialInput,
  threads_publishOptions
};
