import React, { useEffect, useRef, useState } from 'react';
import jsyaml from 'js-yaml';
import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import 'highlight.js/styles/atom-one-dark.css';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('bash', bash);
// YAML Parser simples
        function parseYAML(yamlStr) {
            try {
                return jsyaml.load(yamlStr);
            } catch (e) {
                throw new Error(`YAML inválido: ${e.message}`);
            }
        }

        function fixYAML(yamlStr) {
            let fixed = yamlStr
                .replace(/\t/g, '  ') // tabs para espaços
                .split('\n')
                .map(line => {
                    // Corrigir linhas do tipo "key value" para "key: value"
                    if (line.trim() && !line.includes(':') && line.match(/^\s*\w+\s+\w+/)) {
                        const match = line.match(/^(\s*)(\w+)\s+(.+)$/);
                        if (match) {
                            return `${match[1]}${match[2]}: ${match[3]}`;
                        }
                    }
                    return line;
                })
                .join('\n')
                .replace(/[^\x20-\x7E\n\r\t]/g, '') // remove caracteres inválidos
                .replace(/\n{3,}/g, '\n\n'); // remove excesso de linhas vazias
            return fixed;
        }

        function validateJSON(str) {
            try {
                JSON.parse(str);
                return { valid: true, error: null };
            } catch (e) {
                return { valid: false, error: e.message };
            }
        }

        function validateYAML(str) {
            try {
                jsyaml.load(str);
                return { valid: true, error: null };
            } catch (e) {
                return { valid: false, error: e.message };
            }
        }

        function decodeBase64Utf8(base64) {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
        }

        function looksLikeMojibake(value) {
            if (!value || typeof value !== 'string') return false;
            return /Ã.|Â.|â[\u0080-\u00BF]|�/.test(value);
        }

        function repairMojibake(value) {
            if (value === null || value === undefined) return value;
            let text = String(value);
            if (!looksLikeMojibake(text)) return text;

            // Tenta converter texto Latin-1 mal interpretado para UTF-8.
            for (let i = 0; i < 2; i++) {
                try {
                    const bytes = new Uint8Array(text.length);
                    for (let j = 0; j < text.length; j++) {
                        bytes[j] = text.charCodeAt(j) & 0xFF;
                    }
                    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    if (!decoded || decoded === text) break;
                    text = decoded;
                } catch (e) {
                    break;
                }
                if (!looksLikeMojibake(text)) break;
            }
            return text;
        }

        // Resolver $ref básico
        function resolveRef(spec, ref) {
            if (!ref || !ref.startsWith('#/')) return null;
            const path = ref.substring(2).split('/');
            let current = spec;
            for (const p of path) {
                if (current && typeof current === 'object' && p in current) {
                    current = current[p];
                } else {
                    return null;
                }
            }
            return current;
        }

        // ============================================================================
        // LAYER A: XML NORMALIZATION LAYER
        // Pure helpers for XML traversal - no knowledge of OpenAPI schema
        // ============================================================================

        /**
         * Parse XML string safely and throw if parser errors are detected
         * Returns Document or throws Error
         */
        function parseXmlSafely(xmlString) {
            let xml = xmlString.trim();

            // Verificar se é XML SOAP válido
            try {
                // Primeiro tentar parsear diretamente
                const doc = new DOMParser().parseFromString(xml, 'text/xml');
                
                // Verificar erros de parser
                const parserErrors = doc.getElementsByTagName('parsererror');
                if (parserErrors.length > 0) {
                    // Tentar corrigir problemas comuns
                    let correctedXml = xml;
                    
                    // Corrigir namespaces com espaços
                    correctedXml = correctedXml.replace(/xmlns:\s*"/g, 'xmlns="');
                    correctedXml = correctedXml.replace(/xmlns\s*:\s*([^=]+)\s*=\s*"/g, 'xmlns:$1="');
                    
                    // Corrigir aspas em URLs de namespace
                    correctedXml = correctedXml.replace(/xmlns[^=]*=\s*"\s*`([^`]+)`\s*"/g, 'xmlns="$1"');
                    
                    // Tentar parsear novamente
                    const correctedDoc = new DOMParser().parseFromString(correctedXml, 'text/xml');
                    const newErrors = correctedDoc.getElementsByTagName('parsererror');
                    
                    if (newErrors.length === 0) {
                        return correctedDoc;
                    }
                }
                
                // Se não houver erros, retornar o documento
                if (parserErrors.length === 0) {
                    return doc;
                }
                
            } catch (e) {
                console.warn('Erro ao parsear XML:', e);
            }

            // Se ainda falhar, tentar wrap com root element
            if (!xml.startsWith('<') || xml.match(/<\/\w+>\s*<\w+/)) {
                xml = `<__root__>${xml}</__root__>`;
                const wrappedDoc = new DOMParser().parseFromString(xml, 'text/xml');
                const wrappedErrors = wrappedDoc.getElementsByTagName('parsererror');
                
                if (wrappedErrors.length === 0) {
                    return wrappedDoc;
                }
            }

            throw new Error('Invalid XML input - verifique a sintaxe do XML, especialmente os namespaces');
        }

        /**
         * Get localName from XML node (ignores namespaces)
         */
        function getLocalName(node) {
            if (typeof node === 'string') return node;
            if (node.localName) return node.localName;
            if (node.nodeName) {
                const parts = node.nodeName.split(':');
                return parts[parts.length - 1];
            }
            return node;
        }

        /**
         * Alias for getLocalName - used for namespace-agnostic matching
         */
        function local(node) {
            return getLocalName(node);
        }

        /**
         * Get root element from Document or Element
         */
        function getRootElement(xmlContext) {
            if (!xmlContext) return null;
            if (xmlContext.documentElement) return xmlContext.documentElement;
            if (xmlContext.nodeType === 1) return xmlContext; // ELEMENT_NODE
            return null;
        }

        /**
         * Normalize a field name for resilient matching.
         * Handles namespaces, camelCase, snake_case, kebab-case and punctuation.
         */
        function normalizeFieldName(name) {
            if (!name) return '';
            const raw = String(name);
            const noNs = raw.includes(':') ? raw.split(':').pop() : raw;
            return noNs
                .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                .replace(/[^a-zA-Z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .toLowerCase();
        }

        function tokenizeFieldName(name) {
            const normalized = normalizeFieldName(name);
            if (!normalized) return [];
            return normalized.split('_').filter(Boolean);
        }

        function getPluralVariant(name) {
            if (!name) return name;
            if (name.endsWith('s')) return name;
            if (name.endsWith('y') && name.length > 1) return `${name.slice(0, -1)}ies`;
            return `${name}s`;
        }

        function getNameVariants(name) {
            const normalized = normalizeFieldName(name);
            if (!normalized) return new Set();
            const variants = new Set([normalized, singularize(normalized), getPluralVariant(normalized)]);
            for (const token of tokenizeFieldName(name)) {
                variants.add(token);
            }
            return variants;
        }

        function scoreNameMatch(candidateName, targetName) {
            if (!candidateName || !targetName) return 0;
            const candidateRaw = String(candidateName);
            const targetRaw = String(targetName);
            if (candidateRaw === targetRaw) return 100;
            if (candidateRaw.toLowerCase() === targetRaw.toLowerCase()) return 96;

            const candidateNorm = normalizeFieldName(candidateRaw);
            const targetNorm = normalizeFieldName(targetRaw);
            if (!candidateNorm || !targetNorm) return 0;
            if (candidateNorm === targetNorm) return 92;
            if (singularize(candidateNorm) === singularize(targetNorm)) return 88;

            const candidateVariants = getNameVariants(candidateRaw);
            const targetVariants = getNameVariants(targetRaw);
            if (candidateVariants.has(targetNorm) || targetVariants.has(candidateNorm)) return 84;

            const candidateTokens = tokenizeFieldName(candidateRaw);
            const targetTokens = tokenizeFieldName(targetRaw);
            if (candidateTokens.length === 0 || targetTokens.length === 0) return 0;

            let shared = 0;
            const targetSet = new Set(targetTokens);
            for (const token of candidateTokens) {
                if (targetSet.has(token)) shared++;
            }

            if (shared === 0) return 0;
            const tokenScore = Math.round((shared / Math.max(candidateTokens.length, targetTokens.length)) * 75);
            const prefixBoost = (candidateNorm.startsWith(targetNorm) || targetNorm.startsWith(candidateNorm)) ? 8 : 0;
            return Math.min(82, tokenScore + prefixBoost);
        }

        function chooseBestElementByName(children, targetName, minScore = 60) {
            if (!children || !targetName) return null;
            let best = null;
            let bestScore = 0;
            for (const child of children) {
                const score = scoreNameMatch(getLocalName(child), targetName);
                if (score > bestScore) {
                    bestScore = score;
                    best = child;
                }
            }
            return bestScore >= minScore ? best : null;
        }

        /**
         * Find direct child element by localName (returns first match or null)
         */
        function findChildByLocalName(parentNode, localName) {
            if (!parentNode || !localName) return null;
            const children = parentNode.childNodes || [];
            
            // First pass: exact match
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 1 && getLocalName(child) === localName) {
                    return child;
                }
            }
            
            // Second pass: case-insensitive
            const lowerName = localName.toLowerCase();
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 1 && getLocalName(child).toLowerCase() === lowerName) {
                    return child;
                }
            }
            
            // Third pass: fuzzy normalized matching
            const elementChildren = [];
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 1) elementChildren.push(child);
            }
            return chooseBestElementByName(elementChildren, localName, 64);
        }

        /**
         * Find direct child elements by localName (case-sensitive first, then case-insensitive)
         */
        function findChildElementsByLocalName(parentNode, localName) {
            if (!parentNode || !localName) return [];
            const results = [];
            const children = parentNode.childNodes || [];
            
            // First pass: exact match
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 1 && getLocalName(child) === localName) {
                    results.push(child);
                }
            }
            
            // Second pass: case-insensitive if no exact match
            if (results.length === 0) {
                const lowerName = localName.toLowerCase();
                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    if (child.nodeType === 1 && getLocalName(child).toLowerCase() === lowerName) {
                        results.push(child);
                    }
                }
            }
            
            if (results.length > 0) return results;

            // Third pass: fuzzy matching grouped by best element name
            const elementChildren = [];
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 1) elementChildren.push(child);
            }
            const best = chooseBestElementByName(elementChildren, localName, 64);
            if (!best) return [];

            const bestName = getLocalName(best);
            return elementChildren.filter(child => getLocalName(child) === bestName);
        }

        /**
         * Find all children by localName (returns array)
         */
        function findChildrenByLocalName(parentNode, localName) {
            return findChildElementsByLocalName(parentNode, localName);
        }

        /**
         * Get direct children elements by localName (non-recursive)
         */
        function getDirectChildrenByLocalName(parent, name) {
            if (!parent || !name) return [];
            return findChildElementsByLocalName(parent, name);
        }

        /**
         * Find all descendants by localName (recursive)
         */
        function findDescendantsByLocalName(parent, name) {
            return findAllElementsByLocalName(parent, name);
        }

        /**
         * Singularize a plural name (basic rules)
         */
        function singularize(name) {
            if (!name || name.length < 2) return name;
            if (name.endsWith('es') && name.length > 2) {
                return name.slice(0, -2);
            }
            if (name.endsWith('s')) {
                return name.slice(0, -1);
            }
            return name;
        }

        /**
         * Find the best matching element for an object schema
         * Scores elements by how many schema properties they contain
         */
        function bestMatchElementForObject(parent, schemaProperties) {
            if (!parent || !schemaProperties) return null;
            
            const propertyNames = Object.keys(schemaProperties);
            if (propertyNames.length === 0) return null;
            
            let bestElement = null;
            let bestScore = 0;
            
            const children = parent.childNodes || [];
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType !== 1) continue;
                
                let score = 0;
                for (const propName of propertyNames) {
                    // Check attribute
                    if (child.hasAttribute && child.hasAttribute(propName)) {
                        score += 2;
                    }
                    // Check direct child element
                    const childElement = findChildByLocalName(child, propName);
                    if (childElement) {
                        score += 2;
                    }
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestElement = child;
                }
            }
            
            return bestElement;
        }

        /**
         * Find all descendant elements by localName (recursive search)
         */
        function findAllElementsByLocalName(xmlContext, localName) {
            if (!xmlContext || !localName) return [];
            const results = [];
            const root = getRootElement(xmlContext);
            if (!root) return [];
            
            const walker = (node) => {
                if (node.nodeType === 1) { // ELEMENT_NODE
                    if (getLocalName(node) === localName) {
                        results.push(node);
                    }
                    for (let i = 0; i < node.childNodes.length; i++) {
                        walker(node.childNodes[i]);
                    }
                }
            };
            walker(root);
            return results;
        }

        /**
         * Get attribute value by name (case-sensitive first, then case-insensitive)
         */
        function getAttributeValue(xmlNode, attrName) {
            if (!xmlNode || !xmlNode.attributes || !attrName) return undefined;
            
            // First try exact match
            for (let i = 0; i < xmlNode.attributes.length; i++) {
                const attr = xmlNode.attributes[i];
                const attrLocalName = getLocalName(attr);
                if (attrLocalName === attrName || attr.name === attrName) {
                    return repairMojibake(attr.value);
                }
            }
            
            // Then try case-insensitive
            const lowerName = attrName.toLowerCase();
            for (let i = 0; i < xmlNode.attributes.length; i++) {
                const attr = xmlNode.attributes[i];
                const attrLocalName = getLocalName(attr);
                if (attrLocalName.toLowerCase() === lowerName || attr.name.toLowerCase() === lowerName) {
                    return repairMojibake(attr.value);
                }
            }

            // Fuzzy normalized match
            let bestValue = undefined;
            let bestScore = 0;
            for (let i = 0; i < xmlNode.attributes.length; i++) {
                const attr = xmlNode.attributes[i];
                const attrLocalName = getLocalName(attr);
                const score = Math.max(
                    scoreNameMatch(attrLocalName, attrName),
                    scoreNameMatch(attr.name, attrName)
                );
                if (score > bestScore) {
                    bestScore = score;
                    bestValue = repairMojibake(attr.value);
                }
            }
            if (bestScore >= 70) return bestValue;
            
            return undefined;
        }

        /**
         * Extract primitive value from XML node for a given field name
         * Only returns value if there's a direct match (attribute or child element)
         * Never uses parent context textContent
         */
        function extractPrimitive(node, fieldName) {
            if (!node) return undefined;
            
            // Attribute first (case-insensitive)
            const attrValue = getAttributeValue(node, fieldName);
            if (attrValue !== undefined && attrValue !== '') return attrValue;
            
            // Direct child element (supports exact + case-insensitive + fuzzy matching)
            const child = findChildByLocalName(node, fieldName);
            if (child) {
                const text = repairMojibake(child.textContent?.trim());
                if (text !== undefined && text !== '') return text;
            }

            // If current node name itself maps to the field, use its text
            const ownNameScore = scoreNameMatch(local(node), fieldName);
            if (ownNameScore >= 88) {
                const ownText = repairMojibake(node.textContent?.trim());
                if (ownText !== undefined && ownText !== '') return ownText;
            }
            
            return undefined;
        }

        /**
         * Generic mapping for XML item nodes in "name/value" format.
         * Supports aliases like key/valor/descricao by fuzzy name matching.
         */
        function mapNameValuePair(itemNode) {
            if (!itemNode || itemNode.nodeType !== 1) return null;

            const candidateNameFields = ['name', 'key', 'field', 'nome', 'chave'];
            const candidateValueFields = ['value', 'val', 'content', 'valor', 'conteudo', 'description', 'descricao'];

            let nameField = null;
            let valueField = null;

            for (const key of candidateNameFields) {
                const n = findChildByLocalName(itemNode, key);
                if (n && scoreNameMatch(local(n), key) >= 70) {
                    nameField = n;
                    break;
                }
            }

            for (const key of candidateValueFields) {
                const v = findChildByLocalName(itemNode, key);
                if (v && scoreNameMatch(local(v), key) >= 70) {
                    valueField = v;
                    break;
                }
            }

            const nameText = repairMojibake(nameField?.textContent?.trim());
            const valueText = repairMojibake(valueField?.textContent?.trim());

            if (!nameText || valueText === undefined || valueText === null) return null;
            return { name: nameText, value: valueText };
        }

        /**
         * Select the best payload node from XML document based on schema root properties
         * Scores candidates by how many schema properties they contain
         */
        function selectBestPayloadNode(xmlDoc, schemaRoot) {
            if (!xmlDoc || !xmlDoc.documentElement) return null;
            
            const candidates = [...xmlDoc.getElementsByTagName('*')];
            
            let best = null;
            let bestScore = 0;
            
            if (schemaRoot?.properties) {
                for (const el of candidates) {
                    let score = 0;
                    
                    for (const key of Object.keys(schemaRoot.properties)) {
                        // Check attribute
                        if (getAttributeValue(el, key) !== undefined) {
                            score++;
                        } else {
                            // Check child elements
                            const child = findChildByLocalName(el, key);
                            if (child) score++;
                        }
                    }
                    
                    if (score > bestScore) {
                        best = el;
                        bestScore = score;
                    }
                }
            }
            
            return best || xmlDoc.documentElement;
        }

        // ============================================================================
        // LAYER B: SCHEMA INTROSPECTION LAYER
        // Helpers for schema resolution and type detection
        // ============================================================================

        /**
         * Resolve schema reference and return resolved schema
         */
        function resolveSchema(schema, spec) {
            if (!schema) return null;
            if (schema.$ref) {
                const resolved = resolveRef(spec, schema.$ref);
                if (resolved) return resolveSchema(resolved, spec);
                return null;
            }
            return schema;
        }

        /**
         * Determine the effective type of a schema node
         */
        function getSchemaType(schema, spec) {
            const resolved = resolveSchema(schema, spec);
            if (!resolved) return null;
            if (resolved.type) return resolved.type;
            if (resolved.properties) return 'object';
            if (resolved.items) return 'array';
            return null;
        }

        /**
         * Get properties for an object schema
         */
        function getSchemaProperties(schema, spec) {
            const resolved = resolveSchema(schema, spec);
            if (!resolved || !resolved.properties) return {};
            return resolved.properties;
        }

        /**
         * Get items schema for an array schema
         */
        function getSchemaItems(schema, spec) {
            const resolved = resolveSchema(schema, spec);
            if (!resolved || !resolved.items) return null;
            return resolved.items;
        }

        /**
         * Determine the logical item name for an array
         * Tries to infer from schema.items or uses singular form of array property name
         */
        function getArrayItemName(arrayPropertyName, itemsSchema, spec) {
            const resolved = resolveSchema(itemsSchema, spec);
            if (resolved && resolved.properties) {
                // If items is an object, try to find a common pattern
                // For now, use singular form heuristic
                if (arrayPropertyName.endsWith('s')) {
                    return arrayPropertyName.slice(0, -1);
                }
            }
            // Default: use singular form or the property name itself
            if (arrayPropertyName.endsWith('s') && arrayPropertyName.length > 1) {
                return arrayPropertyName.slice(0, -1);
            }
            return arrayPropertyName;
        }

        function mapXmlToJson(xml, schema, spec, options = {}) {
            const { includeEmptyFields = false } = options;
            const errors = [];

            function mapNode(xmlNode, schemaNode) {
                if (!xmlNode || !schemaNode) return undefined;

                const resolvedSchema = resolveSchema(schemaNode, spec);
                if (!resolvedSchema) {
                    errors.push({ message: `Não foi possível resolver o esquema para o nó XML: ${getLocalName(xmlNode)}` });
                    return undefined;
                }

                const schemaType = getSchemaType(resolvedSchema, spec);

                if (schemaType === 'object') {
                    const obj = {};
                    const properties = getSchemaProperties(resolvedSchema, spec);
                    
                    Object.keys(properties).forEach(propName => {
                        const propSchema = properties[propName];
                        const matchedNode = findMatchingXmlNode(xmlNode, propName, propSchema, spec);
                        
                        let value;
                        if (matchedNode && matchedNode !== xmlNode) {
                            value = mapNode(matchedNode, propSchema);
                        } else if (propSchema.xml && propSchema.xml.attribute) {
                            const attrValue = getAttributeValue(xmlNode, propName);
                            value = convertXmlValue(attrValue, getSchemaType(propSchema, spec));
                        }

                        if (value !== undefined) {
                            obj[propName] = value;
                        } else if (includeEmptyFields) {
                            obj[propName] = "";
                        }
                    });
                    return obj;

                } else if (schemaType === 'array') {
                    const itemsSchema = getSchemaItems(resolvedSchema, spec);
                    if (!itemsSchema) {
                        errors.push({ message: `Esquema de itens ausente para o array no nó: ${getLocalName(xmlNode)}` });
                        return [];
                    }

                    const itemName = getArrayItemName(getLocalName(xmlNode), itemsSchema, spec);
                    const childNodes = findChildrenByLocalName(xmlNode, itemName);
                    
                    if (childNodes.length > 0) {
                        return childNodes.map(child => mapNode(child, itemsSchema)).filter(item => item !== undefined);
                    }
                    return [];

                } else { // Primitivo
                    const textContent = xmlNode.textContent?.trim();
                    if (textContent === '' && !includeEmptyFields) return undefined;
                    
                    const convertedValue = convertXmlValue(textContent, schemaType);
                    
                    // Validação adicional
                    if (resolvedSchema.enum && !resolvedSchema.enum.includes(convertedValue)) {
                        errors.push({ message: `Valor '${convertedValue}' não está no enum para ${getLocalName(xmlNode)}` });
                    }
                    
                    return convertedValue;
                }
            }

            try {
                const xmlDoc = parseXmlSafely(xml);
                const rootElement = selectBestPayloadNode(xmlDoc, schema);
                const result = mapNode(rootElement, schema);
                return { result, errors };
            } catch (error) {
                return { result: null, errors: [{ message: `Erro de análise XML: ${error.message}` }] };
            }
        }

        /**
         * Find matching XML node for a JSON property name
         * Returns the matched node or the current context if not found
         */
        function findMatchingXmlNode(xmlContext, propertyName, schema, spec) {
            if (!xmlContext || !propertyName) return xmlContext;

            let searchRoot = getRootElement(xmlContext);
            if (!searchRoot) return xmlContext;

            const resolvedSchema = resolveSchema(schema, spec);

            // 1) Attribute mapping
            if (resolvedSchema?.xml?.attribute) {
                const attrCandidate = resolvedSchema.xml.name || propertyName;
                if (getAttributeValue(searchRoot, attrCandidate) !== undefined) {
                    return searchRoot;
                }
            }

            // 2) Candidate names from schema and property
            const candidateNames = [];
            if (resolvedSchema?.xml?.name) candidateNames.push(resolvedSchema.xml.name);
            candidateNames.push(propertyName);
            candidateNames.push(singularize(propertyName));
            candidateNames.push(getPluralVariant(propertyName));

            let bestNode = null;
            let bestScore = 0;
            const allChildren = searchRoot.childNodes || [];

            for (let i = 0; i < allChildren.length; i++) {
                const child = allChildren[i];
                if (child.nodeType !== 1) continue;

                let nameScore = 0;
                for (const candidate of candidateNames) {
                    nameScore = Math.max(nameScore, scoreNameMatch(getLocalName(child), candidate));
                }
                if (nameScore === 0) continue;

                // Schema-compatibility boost to disambiguate close names
                let schemaBoost = 0;
                if (resolvedSchema) {
                    const childType = getSchemaType(resolvedSchema, spec);
                    if (childType === 'object' && resolvedSchema.properties) {
                        const keys = Object.keys(resolvedSchema.properties);
                        let matchedKeys = 0;
                        for (const k of keys) {
                            if (getAttributeValue(child, k) !== undefined || findChildByLocalName(child, k)) {
                                matchedKeys++;
                            }
                        }
                        schemaBoost += Math.min(12, matchedKeys * 3);
                    } else if (childType === 'array') {
                        schemaBoost += 4;
                    } else {
                        const hasText = Boolean(child.textContent && child.textContent.trim() !== '');
                        if (hasText) schemaBoost += 5;
                    }
                }

                const total = nameScore + schemaBoost;
                if (total > bestScore) {
                    bestScore = total;
                    bestNode = child;
                }
            }

            if (bestNode && bestScore >= 64) return bestNode;

            // 3) If property likely maps to current node itself
            const ownScore = scoreNameMatch(local(searchRoot), propertyName);
            if (ownScore >= 92) return searchRoot;

            return xmlContext; // Retorna o contexto original se nada for encontrado
        }

        /**
         * Converte o valor de uma string XML para o tipo de esquema de destino.
         */
        function convertXmlValue(value, schemaType) {
            if (value === null || value === undefined) return value;
            const normalizedValue = repairMojibake(value);
            const schemaTypeName = typeof schemaType === 'string' ? schemaType : (schemaType?.type || 'string');

            switch (schemaTypeName) {
                case 'number':
                case 'integer':
                    const num = Number(normalizedValue);
                    return isNaN(num) ? normalizedValue : num; // Retorna o valor original se não for um número
                case 'boolean':
                    if (String(normalizedValue).toLowerCase() === 'true') return true;
                    if (String(normalizedValue).toLowerCase() === 'false') return false;
                    return Boolean(normalizedValue);
                case 'string':
                default:
                    return String(normalizedValue);
            }
        }

        /**
         * Map XML to JSON recursively following OpenAPI schema
         * Uses schema-driven approach with strict primitive matching
         */
        function mapBySchema(schemaNode, contextElement, spec, path = '') {
            if (!schemaNode || !contextElement) return undefined;
            
            // Resolve schema reference
            const resolvedSchema = resolveSchema(schemaNode, spec);
            if (!resolvedSchema) return undefined;
            
            const schemaType = getSchemaType(resolvedSchema, spec);
            
            // Handle objects
            if (schemaType === 'object') {
                const result = {};
                const properties = getSchemaProperties(resolvedSchema, spec);
                
                for (const [propertyName, propertySchema] of Object.entries(properties)) {
                    const propertyPath = path ? `${path}.${propertyName}` : propertyName;
                    
                    // Find matching XML node for this property
                    let matchedNode = findMatchingXmlNode(contextElement, propertyName, propertySchema, spec);
                    
                    // If not found as direct child and property is an object, try best match
                    if ((!matchedNode || matchedNode === contextElement) && propertySchema) {
                        const resolvedPropSchema = resolveSchema(propertySchema, spec);
                        if (resolvedPropSchema && resolvedPropSchema.properties) {
                            matchedNode = bestMatchElementForObject(contextElement, resolvedPropSchema.properties);
                        }
                    }
                    
                    // If still not found, use context element for schema-driven mapping
                    if (!matchedNode) {
                        matchedNode = contextElement;
                    }
                    
                    // Recursively map the property
                    const mappedValue = mapBySchema(propertySchema, matchedNode, spec, propertyPath);
                    
                    // Always include property in result (schema is source of truth)
                    if (mappedValue !== undefined) {
                        result[propertyName] = mappedValue;
                    } else {
                        // No value found - use schema-appropriate empty value
                        const propType = getSchemaType(resolveSchema(propertySchema, spec), spec);
                        if (propType === 'string') {
                            result[propertyName] = '';
                        } else if (propType === 'array') {
                            result[propertyName] = [];
                        } else if (propType === 'object') {
                            result[propertyName] = {};
                        } else {
                            result[propertyName] = null;
                        }
                    }
                }
                
                return result;
            }
            
            // Handle arrays
            if (schemaType === 'array') {
                const itemsSchema = getSchemaItems(resolvedSchema, spec);
                if (!itemsSchema) return [];
                
                // Determine item name from property name in path or schema
                const arrayPropertyName = path.split('.').pop() || 'item';
                
                let itemNodes = [];
                
                // Strategy 1: Look for wrapper element matching array property name
                const wrapperElement = findChildByLocalName(contextElement, arrayPropertyName);
                
                if (wrapperElement) {
                    // Wrapper exists: collect its direct children as candidate items
                    const resolvedItems = resolveSchema(itemsSchema, spec);
                    const children = wrapperElement.childNodes || [];
                    
                    if (resolvedItems && resolvedItems.properties) {
                        // Items is an object: filter children by whether they contain at least one schema property
                        const itemKeys = Object.keys(resolvedItems.properties);
                        for (let i = 0; i < children.length; i++) {
                            const child = children[i];
                            if (child.nodeType === 1) {
                                // Check if this child contains any of the item keys
                                let hasMatch = false;
                                for (const key of itemKeys) {
                                    if (getAttributeValue(child, key) !== undefined) {
                                        hasMatch = true;
                                        break;
                                    }
                                    if (findChildByLocalName(child, key)) {
                                        hasMatch = true;
                                        break;
                                    }
                                }
                                if (hasMatch) {
                                    itemNodes.push(child);
                                }
                            }
                        }
                        
                        // If no children match, check if wrapper element itself matches item schema
                        if (itemNodes.length === 0) {
                            let wrapperMatches = false;
                            for (const key of itemKeys) {
                                if (getAttributeValue(wrapperElement, key) !== undefined) {
                                    wrapperMatches = true;
                                    break;
                                }
                                if (findChildByLocalName(wrapperElement, key)) {
                                    wrapperMatches = true;
                                    break;
                                }
                            }
                            if (wrapperMatches) {
                                itemNodes.push(wrapperElement);
                            }
                        }
                    } else {
                        // Items is not an object or schema not resolved: use all direct children
                        for (let i = 0; i < children.length; i++) {
                            const child = children[i];
                            if (child.nodeType === 1) {
                                itemNodes.push(child);
                            }
                        }
                        
                        // If no children, check if wrapper itself could be an item
                        if (itemNodes.length === 0 && wrapperElement.childNodes.length === 0) {
                            itemNodes.push(wrapperElement);
                        }
                    }
                } else {
                    // Strategy 2: Wrapper not found - search for repeated item elements
                    const resolvedItems = resolveSchema(itemsSchema, spec);
                    let itemName = null;
                    
                    // Strategy 2a: Try singular form of property name
                    itemName = singularize(arrayPropertyName);
                    itemNodes = getDirectChildrenByLocalName(contextElement, itemName);
                    
                    // Strategy 2b: If items schema is object, find elements that best match schema properties
                    if (itemNodes.length === 0 && resolvedItems && resolvedItems.properties) {
                        const itemKeys = Object.keys(resolvedItems.properties);
                        const children = contextElement.childNodes || [];
                        const candidateNames = new Map();
                        
                        for (let i = 0; i < children.length; i++) {
                            const child = children[i];
                            if (child.nodeType === 1) {
                                const childName = local(child);
                                let matchCount = 0;
                                for (const key of itemKeys) {
                                    if (child.hasAttribute && child.hasAttribute(key)) {
                                        matchCount++;
                                    }
                                    if (findChildByLocalName(child, key)) {
                                        matchCount++;
                                    }
                                }
                                if (matchCount > 0) {
                                    const current = candidateNames.get(childName) || 0;
                                    candidateNames.set(childName, current + matchCount);
                                }
                            }
                        }
                        
                        // Find the best candidate
                        let bestName = null;
                        let bestScore = 0;
                        for (const [name, score] of candidateNames.entries()) {
                            if (score > bestScore) {
                                bestScore = score;
                                bestName = name;
                            }
                        }
                        if (bestName) {
                            itemName = bestName;
                            itemNodes = getDirectChildrenByLocalName(contextElement, itemName);
                        }
                    }
                    
                    // Strategy 2c: If still nothing, try singular form variations
                    if (itemNodes.length === 0 && itemName !== arrayPropertyName) {
                        itemNodes = getDirectChildrenByLocalName(contextElement, itemName);
                    }
                }
                
                // Map each item node
                const result = [];
                const resolvedItems = resolveSchema(itemsSchema, spec);
                
                for (const itemNode of itemNodes) {
                    // Check if this is a name/value pair (generic rule)
                    const nameValuePair = mapNameValuePair(itemNode);
                    if (nameValuePair) {
                        // Verify it matches the item schema structure
                        if (resolvedItems && resolvedItems.properties) {
                            const itemKeys = Object.keys(resolvedItems.properties);
                            const hasName = itemKeys.some(k => k.toLowerCase() === 'name');
                            const hasValue = itemKeys.some(k => k.toLowerCase() === 'value');
                            if (hasName && hasValue) {
                                result.push(nameValuePair);
                                continue;
                            }
                        }
                    }
                    
                    // Map item using schema
                    const mappedItem = mapBySchema(itemsSchema, itemNode, spec, `${path}[]`);
                    // Push all mapped items (empty ones will be pruned later if needed)
                    if (mappedItem !== undefined && mappedItem !== null) {
                        result.push(mappedItem);
                    }
                }
                
                return result;
            }
            
            // Handle primitives (string, number, integer, boolean)
            if (schemaType === 'string' || schemaType === 'number' || schemaType === 'integer' || schemaType === 'boolean') {
                const propertyNameRaw = path.split('.').pop() || '';
                const propertyName = propertyNameRaw.replace(/\[\]$/, '');
                let value;

                if (propertyName) {
                    value = extractPrimitive(contextElement, propertyName);
                }

                if (value === undefined || value === '') {
                    // If current element itself is a primitive value node, keep its text
                    const ownText = contextElement.textContent?.trim();
                    const hasElementChildren = Array.from(contextElement.childNodes || []).some(n => n.nodeType === 1);
                    if (!hasElementChildren && ownText !== undefined && ownText !== '') {
                        value = ownText;
                    } else {
                        return undefined;
                    }
                }
                
                // Type conversion
                if (schemaType === 'number' || schemaType === 'integer') {
                    const num = Number(value);
                    if (!isNaN(num)) return schemaType === 'integer' ? Math.floor(num) : num;
                } else if (schemaType === 'boolean') {
                    const lower = value.toLowerCase();
                    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
                    if (lower === 'false' || lower === '0' || lower === 'no') return false;
                }
                return value;
            }
            
            return undefined;
        }

        /**
         * Map XML to JSON recursively following OpenAPI schema (legacy wrapper)
         */
        function mapXmlToJsonRecursive(schema, xmlContext, spec, path = '') {
            if (!schema || !xmlContext) return undefined;
            
            // Get the element context
            let contextElement = xmlContext;
            if (xmlContext.documentElement) {
                contextElement = xmlContext.documentElement;
            } else if (xmlContext.nodeType !== 1) {
                contextElement = getRootElement(xmlContext);
                if (!contextElement) return undefined;
            }
            
            // Use the new mapping function
            return mapBySchema(schema, contextElement, spec, path);
        }

        // Função para remover campos vazios (prune)
        function pruneEmptyFields(obj) {
            if (Array.isArray(obj)) {
                const pruned = obj.map(pruneEmptyFields).filter(v => {
                    if (v === null || v === undefined || v === '') return false;
                    if (typeof v === 'object' && Object.keys(v).length === 0) return false;
                    return true;
                });
                return pruned.length > 0 ? pruned : undefined;
            }
            if (typeof obj === 'object' && obj !== null) {
                const cleaned = {};
                for (const [k, v] of Object.entries(obj)) {
                    const pruned = pruneEmptyFields(v);
                    if (pruned !== null && pruned !== undefined && pruned !== '') {
                        if (typeof pruned === 'object' && !Array.isArray(pruned) && Object.keys(pruned).length === 0) {
                            continue;
                        }
                        cleaned[k] = pruned;
                    }
                }
                return Object.keys(cleaned).length > 0 ? cleaned : undefined;
            }
            // Manter 0 e false (não são vazios)
            if (obj === 0 || obj === false) return obj;
            return obj === '' ? undefined : obj;
        }

        // Gerar exemplo a partir de schema
        function generateExampleFromSchema(schema, spec) {
            if (!schema) return {};
            if (schema.$ref) {
                const resolved = resolveRef(spec, schema.$ref);
                if (resolved) return generateExampleFromSchema(resolved, spec);
                return {};
            }
            if (schema.example !== undefined) return schema.example;
            if (schema.type === 'object') {
                const obj = {};
                if (schema.properties) {
                    for (const [key, prop] of Object.entries(schema.properties)) {
                        const example = generateExampleFromSchema(prop, spec);
                        if (example !== null && example !== undefined) {
                            obj[key] = example;
                        }
                    }
                }
                return obj;
            }
            if (schema.type === 'array') {
                if (schema.items) {
                    const itemExample = generateExampleFromSchema(schema.items, spec);
                    // Never return [null] - return empty array if item example is invalid
                    if (itemExample !== null && itemExample !== undefined) {
                        return [itemExample];
                    }
                }
                return [];
            }
            if (schema.type === 'string') return schema.default || '';
            if (schema.type === 'number' || schema.type === 'integer') return schema.default || 0;
            if (schema.type === 'boolean') return schema.default !== undefined ? schema.default : false;
            return null;
        }

        // Gerar Postman Collection
        function generatePostmanCollection(spec) {
            const collection = {
                info: {
                    name: spec.info?.title || 'OpenAPI Collection',
                    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
                },
                item: [],
                variable: [
                    {
                        key: 'ApigeeHost',
                        value: '',
                        type: 'string'
                    },
                    {
                        key: 'bearerToken',
                        value: '',
                        type: 'string'
                    }
                ],
                auth: {
                    type: 'bearer',
                    bearer: [
                        {
                            key: 'token',
                            value: '{{bearerToken}}',
                            type: 'string'
                        }
                    ]
                }
            };

            const baseHeaders = [
                { key: 'Traceparent', value: '{{$guid}}' },
                { key: 'X-Flow-ID', value: '{{$guid}}' },
                { key: 'X-application', value: 'POSTMAN' },
                { key: 'X-originalApplication', value: 'POSTMAN' },
                { key: 'X-process', value: 'Testing' },
                { key: 'X-user', value: 'U80063362' },
                { key: 'Content-Type', value: 'application/json' },
                { key: 'Accept', value: 'application/json' },
                { key: 'Authorization', value: '{{bearerToken}}' }
            ];

            // Pre-request script para autenticação
            const authScript = `
const key = pm.environment.get("key") || "";
const secret = pm.environment.get("secret") || "";
const tokenIssuedAt = pm.environment.get("tokenIssuedAt");
const tokenExpiresIn = pm.environment.get("tokenExpiresIn");
const now = Date.now();

// Verificar se token ainda é válido (renovar se faltar menos de 5 minutos)
const shouldRenew = !tokenIssuedAt || !tokenExpiresIn || 
    (now - parseInt(tokenIssuedAt)) > (parseInt(tokenExpiresIn) - 300) * 1000;

if (shouldRenew && key && secret) {
    const authRequest = {
        url: pm.variables.get("ApigeeHost") + "/authentication/v2",
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        body: {
            mode: 'raw',
            raw: JSON.stringify({ key, secret })
        }
    };
    
    pm.sendRequest(authRequest, (err, res) => {
        if (err || res.code !== 200) {
            // Tentar endpoint alternativo
            authRequest.url = pm.variables.get("ApigeeHost") + "/common/authentication/v1";
            pm.sendRequest(authRequest, (err2, res2) => {
                if (!err2 && res2.code === 200) {
                    const body = res2.json();
                    pm.environment.set("bearerToken", body.access_token || body.token || "");
                    pm.environment.set("tokenIssuedAt", now.toString());
                    pm.environment.set("tokenExpiresIn", (body.expires_in || 3600).toString());
                    pm.environment.set("tokenAuthEndpoint", authRequest.url);
                }
            });
        } else {
            const body = res.json();
            pm.environment.set("bearerToken", body.access_token || body.token || "");
            pm.environment.set("tokenIssuedAt", now.toString());
            pm.environment.set("tokenExpiresIn", (body.expires_in || 3600).toString());
            pm.environment.set("tokenAuthEndpoint", authRequest.url);
        }
    });
}
`;

            if (spec.paths) {
                for (const [path, methods] of Object.entries(spec.paths)) {
                    for (const [method, operation] of Object.entries(methods)) {
                        if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method.toLowerCase())) continue;

                        const item = {
                            name: operation.operationId || `${method.toUpperCase()} ${path}`,
                            request: {
                                method: method.toUpperCase(),
                                header: [...baseHeaders],
                                url: {
                                    raw: `{{ApigeeHost}}${path}`,
                                    host: ['{{ApigeeHost}}'],
                                    path: path.split('/').filter(p => p)
                                },
                                description: operation.description || operation.summary || ''
                            },
                            response: []
                        };

                        // Query parameters
                        if (operation.parameters) {
                            const queryParams = operation.parameters
                                .filter(p => p.in === 'query')
                                .map(p => ({
                                    key: p.name,
                                    value: p.example || p.default || '',
                                    description: p.description || ''
                                }));
                            if (queryParams.length > 0) {
                                item.request.url.query = queryParams;
                            }

                            // Header parameters
                            const headerParams = operation.parameters
                                .filter(p => p.in === 'header')
                                .map(p => ({
                                    key: p.name,
                                    value: p.example || p.default || '',
                                    description: p.description || ''
                                }));
                            item.request.header.push(...headerParams);
                        }

                        // Path parameters
                        const pathParams = path.match(/\{([^}]+)\}/g);
                        if (pathParams) {
                            if (!item.request.url.variable) item.request.url.variable = [];
                            pathParams.forEach(param => {
                                const name = param.replace(/[{}]/g, '');
                                const paramDef = operation.parameters?.find(p => p.name === name && p.in === 'path');
                                item.request.url.variable.push({
                                    key: name,
                                    value: paramDef?.example || paramDef?.default || '',
                                    description: paramDef?.description || ''
                                });
                            });
                        }

                        // Body
                        if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && operation.requestBody) {
                            const jsonContent = operation.requestBody.content?.['application/json'];
                            if (jsonContent) {
                                let bodyData = {};
                                if (jsonContent.example) {
                                    bodyData = typeof jsonContent.example === 'string' 
                                        ? JSON.parse(jsonContent.example) 
                                        : jsonContent.example;
                                } else if (jsonContent.schema) {
                                    bodyData = generateExampleFromSchema(jsonContent.schema, spec);
                                }
                                item.request.body = {
                                    mode: 'raw',
                                    raw: JSON.stringify(bodyData, null, 2),
                                    options: {
                                        raw: {
                                            language: 'json'
                                        }
                                    }
                                };
                            }
                        }

                        // Pre-request script
                        item.event = [{
                            listen: 'prerequest',
                            script: {
                                type: 'text/javascript',
                                exec: authScript.split('\n')
                            }
                        }];

                        collection.item.push(item);
                    }
                }
            }

            return collection;
        }

        // Componente principal
        function App() {
            const [activeTab, setActiveTab] = useState(0);
            
            // CSV state lifted to App component for persistence
            const [csvData, setCsvData] = useState([]);
            const [csvHeaders, setCsvHeaders] = useState([]);
            const [csvSearchTerm, setCsvSearchTerm] = useState('');
            const [csvFilterAvailable, setCsvFilterAvailable] = useState(true);
            const [csvSelectedRow, setCsvSelectedRow] = useState(null);

            return (
                <div className="max-w-7xl mx-auto px-4">
                    <h1 className="text-3xl font-bold text-gray-900 mb-6">OpenAPI Toolbox</h1>
                    
                    <div className="bg-white rounded-lg shadow-lg">
                        <div className="border-b border-gray-200">
                            <nav className="flex space-x-8 px-6">
                                {['Gerador cURL', 'Pesquisa CSV', 'OpenAPI → Postman'].map((tab, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => setActiveTab(idx)}
                                        className={`py-4 px-1 border-b-2 font-medium text-sm ${
                                            activeTab === idx
                                                ? 'border-blue-500 text-blue-600'
                                                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                                        }`}
                                    >
                                        {tab}
                                    </button>
                                ))}
                            </nav>
                        </div>

                        <div className="p-6">
                            <div className={activeTab === 0 ? 'block' : 'hidden'}>
                                <CurlGenerator csvData={csvData} />
                            </div>

                            <div className={activeTab === 1 ? 'block' : 'hidden'}>
                                <CSVSearch
                                    csvData={csvData}
                                    setCsvData={setCsvData}
                                    headers={csvHeaders}
                                    setHeaders={setCsvHeaders}
                                    searchTerm={csvSearchTerm}
                                    setSearchTerm={setCsvSearchTerm}
                                    filterAvailable={csvFilterAvailable}
                                    setFilterAvailable={setCsvFilterAvailable}
                                    selectedRow={csvSelectedRow}
                                    setSelectedRow={setCsvSelectedRow}
                                />
                            </div>

                            <div className={activeTab === 2 ? 'block' : 'hidden'}>
                                <OpenAPIToPostman />
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        // TAB 1: OpenAPI → Postman
        function OpenAPIToPostman() {
            const [specText, setSpecText] = useState('');
            const [validationStatus, setValidationStatus] = useState(null);
            const [collectionJson, setCollectionJson] = useState('');
            const fileInputRef = useRef(null);

            const handleFileLoad = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    setSpecText(event.target.result);
                    setValidationStatus(null);
                    setCollectionJson('');
                };
                reader.readAsText(file);
            };

            const handleValidate = () => {
                if (!specText.trim()) {
                    setValidationStatus({ type: 'error', message: 'Por favor, cole ou carregue uma spec OpenAPI' });
                    return;
                }

                let spec;
                let isValid = false;
                let error = null;

                // Tentar JSON primeiro
                const jsonResult = validateJSON(specText);
                if (jsonResult.valid) {
                    try {
                        spec = JSON.parse(specText);
                        isValid = true;
                    } catch (e) {
                        error = e.message;
                    }
                } else {
                    // Tentar YAML
                    const yamlResult = validateYAML(specText);
                    if (yamlResult.valid) {
                        try {
                            spec = parseYAML(specText);
                            isValid = true;
                        } catch (e) {
                            error = e.message;
                        }
                    } else {
                        error = yamlResult.error;
                    }
                }

                if (isValid) {
                    setValidationStatus({ type: 'success', message: 'OpenAPI spec válida!' });
                } else {
                    setValidationStatus({ type: 'error', message: `Erro: ${error}` });
                }
            };

            const handleFixYAML = () => {
                if (!specText.trim()) return;
                const fixed = fixYAML(specText);
                setSpecText(fixed);
                setValidationStatus({ type: 'info', message: 'YAML corrigido. Valide novamente.' });
            };

            const handleGenerate = () => {
                if (!specText.trim()) {
                    setValidationStatus({ type: 'error', message: 'Por favor, cole ou carregue uma spec OpenAPI' });
                    return;
                }

                let spec;
                try {
                    const jsonResult = validateJSON(specText);
                    if (jsonResult.valid) {
                        spec = JSON.parse(specText);
                    } else {
                        const yamlResult = validateYAML(specText);
                        if (!yamlResult.valid) {
                            setValidationStatus({ type: 'error', message: 'Spec inválida. Valide primeiro.' });
                            return;
                        }
                        spec = parseYAML(specText);
                    }
                } catch (e) {
                    setValidationStatus({ type: 'error', message: `Erro ao processar: ${e.message}` });
                    return;
                }

                try {
                    const collection = generatePostmanCollection(spec);
                    setCollectionJson(JSON.stringify(collection, null, 2));
                    setValidationStatus({ type: 'success', message: 'Collection gerada com sucesso!' });
                } catch (e) {
                    setValidationStatus({ type: 'error', message: `Erro ao gerar collection: ${e.message}` });
                }
            };

            const handleCopy = () => {
                if (collectionJson) {
                    navigator.clipboard.writeText(collectionJson).then(() => {
                        setValidationStatus({ type: 'success', message: 'Copiado para clipboard!' });
                    });
                }
            };

            const handleExport = () => {
                if (collectionJson) {
                    const blob = new Blob([collectionJson], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'postman-collection.json';
                    a.click();
                    URL.revokeObjectURL(url);
                }
            };

            const handleClear = () => {
                setSpecText('');
                setCollectionJson('');
                setValidationStatus(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
            };

            return (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            OpenAPI Spec (YAML ou JSON)
                        </label>
                        <textarea
                            value={specText}
                            onChange={(e) => setSpecText(e.target.value)}
                            className="w-full h-64 p-3 border border-gray-300 rounded-md font-mono text-sm"
                            placeholder="Cole aqui a sua OpenAPI spec ou use o botão para carregar um ficheiro..."
                        />
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".yaml,.yml,.json"
                            onChange={handleFileLoad}
                            className="hidden"
                            id="file-input"
                        />
                        <label
                            htmlFor="file-input"
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 cursor-pointer"
                        >
                            📄 Carregar ficheiro
                        </label>
                        <button
                            onClick={handleValidate}
                            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                        >
                            ✅ Validar YAML/JSON
                        </button>
                        <button
                            onClick={handleFixYAML}
                            className="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700"
                        >
                            🔧 Corrigir YAML
                        </button>
                        <button
                            onClick={handleGenerate}
                            className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700"
                        >
                            🚀 Gerar Collection Postman
                        </button>
                    </div>

                    {validationStatus && (
                        <div className={`p-3 rounded-md ${
                            validationStatus.type === 'success' ? 'bg-green-100 text-green-800' :
                            validationStatus.type === 'error' ? 'bg-red-100 text-red-800' :
                            'bg-blue-100 text-blue-800'
                        }`}>
                            {validationStatus.message}
                        </div>
                    )}

                    {collectionJson && (
                        <div className="space-y-2">
                            <label className="block text-sm font-medium text-gray-700">
                                Postman Collection JSON
                            </label>
                            <textarea
                                readOnly
                                value={collectionJson}
                                className="w-full h-64 p-3 border border-gray-300 rounded-md font-mono text-xs bg-gray-50"
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={handleCopy}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                                >
                                    📋 Copiar
                                </button>
                                <button
                                    onClick={handleExport}
                                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                                >
                                    💾 Exportar JSON
                                </button>
                                <button
                                    onClick={handleClear}
                                    className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
                                >
                                    🗑️ Limpar
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            );
        }

        // TAB 2: Pesquisa CSV
        function CSVSearch({ csvData, setCsvData, headers, setHeaders, searchTerm, setSearchTerm, filterAvailable, setFilterAvailable, selectedRow, setSelectedRow }) {
            const listRef = useRef(null);
            const [groupBy, setGroupBy] = useState('target');
            const [expandedGroups, setExpandedGroups] = useState({});
            const [activeIndex, setActiveIndex] = useState(0);
            const [drawerOpen, setDrawerOpen] = useState(false);

            const DATASET_CACHE_KEY = 'openapi_toolbox_dataset_cache_v1';
            const DATASET_TTL_MS = 5 * 60 * 1000;

            const readCachedDataset = () => {
                try {
                    const raw = localStorage.getItem(DATASET_CACHE_KEY);
                    if (!raw) return null;
                    const parsed = JSON.parse(raw);
                    if (!parsed?.ts || !parsed?.base64) return null;
                    if (Date.now() - parsed.ts > DATASET_TTL_MS) return null;
                    return parsed;
                } catch (e) {
                    return null;
                }
            };

            const writeCachedDataset = (payload) => {
                try {
                    localStorage.setItem(DATASET_CACHE_KEY, JSON.stringify(payload));
                } catch (e) {
                    // ignore cache write failures
                }
            };

            const fetchDatasetFromApi = async () => {
                const localToken = localStorage.getItem('dataset_token');
                const envToken = import.meta.env.VITE_DATASET_TOKEN;
                const token = (localToken || envToken || '').trim();
                const headers = token ? { 'X-API-Key': token } : {};

                const response = await fetch('/api/dataset', { headers, cache: 'no-store' });
                if (response.status === 401) {
                    throw new Error('AUTH_REQUIRED');
                }
                if (!response.ok) {
                    throw new Error(`Falha ao carregar dataset (${response.status})`);
                }
                return response.json();
            };

            const getValue = (row, keys) => {
                for (const key of keys) {
                    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
                        return String(row[key]).trim();
                    }
                }
                return '';
            };

            const getMethod = (row) => getValue(row, ['METHOD', 'Method', 'method']) || 'N/A';
            const getPath = (row) => getValue(row, ['PATH', 'Path', 'path']) || '-';
            const getVersion = (row) => getValue(row, ['VERSION', 'Version', 'version']) || 'None';
            const getTargetName = (row) => getValue(row, ['TARGET NAME', 'TARGET_NAME', 'Target Name', 'targetName']) || 'No target';
            const getTargetPath = (row) => getValue(row, ['TARGET PATH', 'TARGET_PATH', 'Target Path', 'targetPath']) || '-';
            const getTargetService = (row) => getValue(row, ['TARGET SERVICE', 'TARGET_SERVICE', 'Target Service', 'targetService']) || '-';
            const getStatus = (row) => getValue(row, ['STATUS', 'Status', 'status']).toLowerCase();
            const getProxyName = (row) => getValue(row, ['NAME', 'Name', 'name']) || '';
            const getPlatform = (row) => getValue(row, ['PLATFORM', 'Platform', 'platform']) || '';
            const getNetwork = (row) => getValue(row, ['NETWORK', 'Network', 'network']) || '-';

            const docsPortalBase = 'https://apigee-p-693214-teste.apigee.io/docs';
            const docsDownloadBase = 'https://apigee-p-693214-teste.apigee.io/portals/api/sites/apigee-p-693214-teste/liveportal/apis';

            const normalizeDocsApiName = (name) => {
                if (!name) return '';
                return String(name)
                    .trim()
                    .toLowerCase()
                    .replace(/[\s_]+/g, '-')
                    .replace(/[^a-z0-9-]/g, '')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '');
            };

            const normalizeDocsApiNameKeepCase = (name) => {
                if (!name) return '';
                return String(name)
                    .trim()
                    .replace(/[\s_]+/g, '-')
                    .replace(/[^a-zA-Z0-9-]/g, '')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '');
            };

            const getDocsVersion = (row) => {
                // O portal de docs usa versão de documentação própria; por omissão é 1.
                const explicitDocVersion = getValue(row, ['Docs Version', 'DOCS VERSION', 'docsVersion', 'Api Docs Version']);
                if (explicitDocVersion && /^\d+$/.test(explicitDocVersion.trim())) {
                    return explicitDocVersion.trim();
                }
                return '1';
            };

            const buildDocsApiSlug = (row) => {
                const platform = getPlatform(row).toLowerCase().replace(/\s+/g, '');
                const rawProxyName = getProxyName(row);
                if (!rawProxyName) return '';
                const normalizedProxyName = normalizeDocsApiName(rawProxyName);
                if (!normalizedProxyName) return '';

                if (platform === 'apigee-hybrid') {
                    return normalizedProxyName.endsWith('-dev') ? normalizedProxyName : `${normalizedProxyName}-dev`;
                }

                if (platform === 'apigee-x' || platform === 'apigeex') {
                    if (normalizedProxyName.startsWith('apigee-x-temp-')) {
                        return normalizedProxyName;
                    }
                    if (normalizedProxyName.startsWith('apigee-x-')) {
                        return normalizedProxyName.replace(/^apigee-x-/, 'apigee-x-temp-');
                    }
                    return `apigee-x-temp-${normalizedProxyName}`;
                }

                return '';
            };

            const buildOperationDocsUrl = (row) => {
                const apiSlug = buildDocsApiSlug(row);
                if (!apiSlug) return '';
                const docsVersion = getDocsVersion(row);
                return `${docsPortalBase}/${apiSlug}/${docsVersion}/overview`;
            };

            const buildOperationDownloadSpecUrl = (row) => {
                let apiSlug = buildDocsApiSlug(row);
                if (!apiSlug) return '';
                const platform = getPlatform(row).toLowerCase().replace(/\s+/g, '');
                if (platform === 'apigee-x' || platform === 'apigeex') {
                    // Use Name with case preserved for download endpoint, as some portal snapshots
                    // can be case-sensitive on api id.
                    const rawProxyName = getProxyName(row);
                    const rawSlug = normalizeDocsApiNameKeepCase(rawProxyName);
                    if (rawSlug) {
                        if (/^apigee-x-temp-/i.test(rawSlug)) {
                            apiSlug = rawSlug;
                        } else if (/^apigee-x-/i.test(rawSlug)) {
                            apiSlug = rawSlug.replace(/^apigee-x-/i, 'apigee-x-temp-');
                        } else {
                            apiSlug = `apigee-x-temp-${rawSlug}`;
                        }
                    } else if (!apiSlug.startsWith('apigee-x-temp-')) {
                        if (apiSlug.startsWith('apigee-x-')) {
                            apiSlug = apiSlug.replace(/^apigee-x-/, 'apigee-x-temp-');
                        } else {
                            apiSlug = `apigee-x-temp-${apiSlug}`;
                        }
                    }
                }
                return `${docsDownloadBase}/${apiSlug}/download_spec`;
            };

            const getBasePath = (row) => {
                const rawPath = getPath(row);
                if (!rawPath || rawPath === '-') return '-';
                const segments = rawPath.split('/').filter(Boolean);
                if (segments.length <= 3) return `/${segments.join('/')}`;
                return `/${segments.slice(0, 3).join('/')}`;
            };

            const getGroupKey = (row) => {
                if (groupBy === 'method') return getMethod(row);
                if (groupBy === 'basePath') return getBasePath(row);
                return getTargetName(row);
            };

            const parseAndSetCsv = (text) => {
                const lines = text.split('\n').filter(l => l.trim());
                if (lines.length === 0) return;

                const headerLine = lines[0];
                const csvHeaders = headerLine.split(';').map(h => h.trim());
                setHeaders(csvHeaders);

                const data = [];
                for (let i = 1; i < lines.length; i++) {
                    const values = lines[i].split(';').map(v => v.trim());
                    const row = {};
                    csvHeaders.forEach((header, idx) => {
                        row[header] = values[idx] || '';
                    });
                    data.push(row);
                }
                setCsvData(data);
            };

            useEffect(() => {
                if (csvData.length > 0) return;

                const cached = readCachedDataset();
                if (cached?.base64) {
                    const decoded = decodeBase64Utf8(cached.base64);
                    parseAndSetCsv(decoded);
                    return;
                }

                fetchDatasetFromApi()
                    .then((payload) => {
                        if (!payload?.base64) {
                            throw new Error('Dataset inválido');
                        }
                        writeCachedDataset({
                            ts: Date.now(),
                            version: payload.version || '',
                            hash: payload.hash || '',
                            base64: payload.base64
                        });
                        const decoded = decodeBase64Utf8(payload.base64);
                        parseAndSetCsv(decoded);
                    })
                    .catch((err) => {
                        if (err?.message === 'AUTH_REQUIRED') {
                            console.warn('API dataset requer token: defina dataset_token no localStorage.');
                            return;
                        }
                        console.warn('Falha ao carregar dataset via API:', err);
                    });
            }, [csvData.length]);

            const handleFileLoad = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    const text = event.target.result;
                    parseAndSetCsv(text);
                    setSelectedRow(null);
                };
                reader.readAsText(file);
            };

            const filteredData = React.useMemo(() => {
                return csvData.filter(row => {
                    if (filterAvailable && getStatus(row) !== 'available') return false;
                    if (!searchTerm) return true;
                    const searchLower = searchTerm.toLowerCase();
                    return Object.values(row).some(val => String(val).toLowerCase().includes(searchLower));
                });
            }, [csvData, filterAvailable, searchTerm]);

            const mergedFilteredData = React.useMemo(() => {
                const map = new Map();
                for (const row of filteredData) {
                    const mergeKey = [
                        getMethod(row),
                        getPath(row),
                        getVersion(row),
                        getTargetName(row),
                        getTargetPath(row),
                        getTargetService(row),
                        getProxyName(row),
                        getPlatform(row),
                        getStatus(row)
                    ].join('||');

                    if (!map.has(mergeKey)) {
                        map.set(mergeKey, {
                            firstRow: row,
                            rows: [row],
                            networks: new Set([getNetwork(row)])
                        });
                    } else {
                        const item = map.get(mergeKey);
                        item.rows.push(row);
                        item.networks.add(getNetwork(row));
                    }
                }

                return Array.from(map.values()).map((item) => {
                    const mergedNetworks = Array.from(item.networks).filter(Boolean);
                    const mergedRow = { ...item.firstRow };
                    mergedRow.__mergedRows = item.rows;
                    mergedRow.__mergedNetworks = mergedNetworks;
                    mergedRow.__isMerged = mergedNetworks.length > 1;
                    mergedRow.Network = mergedNetworks.join(', ');
                    mergedRow.NETWORK = mergedNetworks.join(', ');
                    return mergedRow;
                });
            }, [filteredData]);

            const groupedData = React.useMemo(() => {
                const groups = {};
                for (const row of mergedFilteredData) {
                    const key = getGroupKey(row) || 'Sem grupo';
                    if (!groups[key]) groups[key] = [];
                    groups[key].push(row);
                }
                const ordered = Object.entries(groups)
                    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
                return ordered;
            }, [mergedFilteredData, groupBy]);

            useEffect(() => {
                const next = {};
                groupedData.forEach(([key], idx) => {
                    next[key] = expandedGroups[key] !== undefined ? expandedGroups[key] : idx < 8;
                });
                setExpandedGroups(next);
            }, [groupedData.length, groupBy]);

            const visibleRows = React.useMemo(() => {
                const rows = [];
                groupedData.forEach(([groupKey, groupRows]) => {
                    if (!expandedGroups[groupKey]) return;
                    groupRows.forEach(row => rows.push(row));
                });
                return rows;
            }, [groupedData, expandedGroups]);

            useEffect(() => {
                if (visibleRows.length === 0) {
                    setActiveIndex(0);
                    return;
                }
                setActiveIndex(prev => Math.max(0, Math.min(prev, visibleRows.length - 1)));
            }, [visibleRows.length]);

            const handleKeyboardList = (e) => {
                if (!visibleRows.length) return;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveIndex((idx) => Math.min(idx + 1, visibleRows.length - 1));
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveIndex((idx) => Math.max(idx - 1, 0));
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const row = visibleRows[activeIndex];
                    if (row) setSelectedRow(row);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSelectedRow(null);
                    setDrawerOpen(false);
                }
            };

            const toggleGroup = (key) => {
                setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
            };

            const methodBadgeClass = (method) => {
                const upper = String(method).toUpperCase();
                if (upper === 'GET') return 'bg-emerald-100 text-emerald-800';
                if (upper === 'POST') return 'bg-blue-100 text-blue-800';
                if (upper === 'PUT') return 'bg-amber-100 text-amber-800';
                if (upper === 'DELETE') return 'bg-rose-100 text-rose-800';
                if (upper === 'PATCH') return 'bg-violet-100 text-violet-800';
                return 'bg-slate-100 text-slate-700';
            };

            const networkBadgeClass = (network) => {
                const n = String(network || '').toLowerCase();
                if (n === 'public') return 'bg-cyan-100 text-cyan-800 border-cyan-200';
                if (n === 'private') return 'bg-violet-100 text-violet-800 border-violet-200';
                return 'bg-slate-100 text-slate-700 border-slate-200';
            };

            const platformBadgeClass = (platform) => {
                const p = String(platform || '').toLowerCase().replace(/\s+/g, '');
                if (p === 'apigee-x' || p === 'apigeex') return 'bg-amber-100 text-amber-800 border-amber-200';
                if (p === 'apigee-hybrid' || p === 'apigeehybrid') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
                return 'bg-slate-100 text-slate-700 border-slate-200';
            };

            const getMergedNetworks = (row) => {
                if (Array.isArray(row?.__mergedNetworks) && row.__mergedNetworks.length > 0) {
                    return row.__mergedNetworks;
                }
                const network = getNetwork(row);
                return network && network !== '-' ? [network] : [];
            };

            const isNetworkHeader = (header) => /^network$/i.test(String(header || '').trim());
            const isPlatformHeader = (header) => /^platform$/i.test(String(header || '').trim());

            const DetailPanel = ({ row }) => {
                if (!row) {
                    return (
                        <div className="h-full flex items-center justify-center text-sm text-slate-500">
                            Selecione uma operação para ver detalhes.
                        </div>
                    );
                }

                const docsUrl = buildOperationDocsUrl(row);
                const downloadSpecUrl = buildOperationDownloadSpecUrl(row);
                const mergedNetworks = getMergedNetworks(row);

                return (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-slate-900">Detalhe da Operação</h3>
                            <span className={`px-2 py-0.5 text-xs rounded-full font-semibold ${methodBadgeClass(getMethod(row))}`}>
                                {getMethod(row)}
                            </span>
                        </div>
                        <div className="text-xs text-slate-500 font-mono break-all">{getPath(row)}</div>
                        <div className="grid grid-cols-1 gap-2 text-sm">
                            <div><span className="text-slate-500">Version:</span> <span className="text-slate-900">{getVersion(row)}</span></div>
                            <div><span className="text-slate-500">Target Name:</span> <span className="text-slate-900">{getTargetName(row)}</span></div>
                            <div><span className="text-slate-500">Target Path:</span> <span className="text-slate-900 break-all">{getTargetPath(row)}</span></div>
                            <div><span className="text-slate-500">Base Path:</span> <span className="text-slate-900">{getBasePath(row)}</span></div>
                            <div className="flex items-start gap-2">
                                <span className="text-slate-500">Network:</span>
                                <div className="flex flex-wrap gap-1">
                                    {mergedNetworks.length > 0 ? mergedNetworks.map((network, idx) => (
                                        <span
                                            key={`${network}-${idx}`}
                                            className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${networkBadgeClass(network)}`}
                                        >
                                            {network}
                                        </span>
                                    )) : <span className="text-slate-900">-</span>}
                                </div>
                            </div>
                            {row.__isMerged && (
                                <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1 w-fit">
                                    Registo consolidado: {row.__mergedRows?.length || 2} entradas combinadas.
                                </div>
                            )}
                            <div>
                                <span className="text-slate-500">Docs URL:</span>{' '}
                                {docsUrl ? (
                                    <a
                                        href={docsUrl}
                                        target="_blank"
                                        rel="noopener"
                                        className="text-blue-700 hover:text-blue-900 underline break-all"
                                        title={docsUrl}
                                    >
                                        {docsUrl}
                                    </a>
                                ) : (
                                    <span className="text-slate-900">-</span>
                                )}
                            </div>
                            <div>
                                <span className="text-slate-500">Download YAML:</span>{' '}
                                {downloadSpecUrl ? (
                                    <a
                                        href={downloadSpecUrl}
                                        target="_blank"
                                        rel="noopener"
                                        className="text-blue-700 hover:text-blue-900 underline break-all"
                                        title={downloadSpecUrl}
                                    >
                                        {downloadSpecUrl}
                                    </a>
                                ) : (
                                    <span className="text-slate-900">-</span>
                                )}
                            </div>
                        </div>
                        <div className="border-t pt-3">
                            <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Campos completos</h4>
                            <div className="space-y-1 text-xs max-h-96 overflow-auto pr-1">
                                {headers.map((header, idx) => (
                                    <div key={idx} className="grid grid-cols-[120px_1fr] gap-2">
                                        <span className="text-slate-500">{header}</span>
                                        {isNetworkHeader(header) ? (
                                            <div className="flex flex-wrap gap-1">
                                                {mergedNetworks.length > 0 ? mergedNetworks.map((network, netIdx) => (
                                                    <span
                                                        key={`${header}-${network}-${netIdx}`}
                                                        className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${networkBadgeClass(network)}`}
                                                    >
                                                        {network}
                                                    </span>
                                                )) : <span className="text-slate-900">-</span>}
                                            </div>
                                        ) : isPlatformHeader(header) ? (
                                            (() => {
                                                const platform = getPlatform(row);
                                                return platform && platform !== '-' ? (
                                                    <span
                                                        className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold ${platformBadgeClass(platform)}`}
                                                    >
                                                        {platform}
                                                    </span>
                                                ) : <span className="text-slate-900">-</span>;
                                            })()
                                        ) : (
                                            <span className="text-slate-900 break-all">{row[header] || '-'}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            };

            let visibleIdx = -1;

            return (
                <div className="space-y-4">
                    <div>
                        <input
                            type="file"
                            accept=".csv"
                            onChange={handleFileLoad}
                            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                        />
                    </div>

                    {csvData.length > 0 && (
                        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] gap-4">
                            <div className="space-y-3">
                                <div className="border border-slate-200 rounded-md bg-white p-3 space-y-3">
                                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2">
                                        <input
                                            type="text"
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            placeholder="Procurar endpoint, target, método..."
                                            className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                                        />
                                        <select
                                            value={groupBy}
                                            onChange={(e) => setGroupBy(e.target.value)}
                                            className="px-3 py-2 border border-slate-300 rounded-md text-sm bg-white"
                                        >
                                            <option value="target">Agrupar: Target</option>
                                            <option value="method">Agrupar: Method</option>
                                            <option value="basePath">Agrupar: Base Path</option>
                                        </select>
                                        <button
                                            onClick={() => {
                                                if (visibleRows[0]) setSelectedRow(visibleRows[0]);
                                            }}
                                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
                                        >
                                            Abrir detalhe
                                        </button>
                                        <label className="flex items-center gap-2 text-sm px-2">
                                            <input
                                                type="checkbox"
                                                checked={filterAvailable}
                                                onChange={(e) => setFilterAvailable(e.target.checked)}
                                            />
                                            <span>Só STATUS=available</span>
                                        </label>
                                    </div>

                                    <div className="text-xs text-slate-500">
                                        {mergedFilteredData.length} resultados · {groupedData.length} grupos · atalhos: ↑ ↓ Enter Esc
                                    </div>
                                </div>

                                <div
                                    ref={listRef}
                                    tabIndex={0}
                                    onKeyDown={handleKeyboardList}
                                    className="border border-slate-200 rounded-md bg-white overflow-hidden focus:outline-none focus:ring-2 focus:ring-blue-400"
                                >
                                    <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 px-3 py-2 text-xs text-slate-500 flex items-center justify-between">
                                        <span>Lista de Operações</span>
                                        {selectedRow && (
                                            <span className="font-mono text-[11px] text-slate-600 truncate max-w-[60%]">
                                                Ativa: {getMethod(selectedRow)} {getPath(selectedRow)}
                                            </span>
                                        )}
                                    </div>

                                    <div className="max-h-[760px] overflow-auto">
                                        {groupedData.length === 0 && (
                                            <div className="p-4 text-sm text-slate-500">Sem resultados para os filtros atuais.</div>
                                        )}

                                        {groupedData.map(([groupKey, rows]) => {
                                            const isExpanded = expandedGroups[groupKey];
                                            return (
                                                <div key={groupKey} className="border-b border-slate-100 last:border-b-0">
                                                    <button
                                                        onClick={() => toggleGroup(groupKey)}
                                                        className="w-full flex items-center justify-between px-3 py-2 text-left bg-slate-50 hover:bg-slate-100"
                                                    >
                                                        <span className="text-sm font-medium text-slate-800 truncate">{groupKey}</span>
                                                        <span className="text-xs text-slate-500">{rows.length} · {isExpanded ? 'colapsar' : 'expandir'}</span>
                                                    </button>

                                                    {isExpanded && rows.map((row, idx) => {
                                                        visibleIdx += 1;
                                                        const isActive = visibleIdx === activeIndex;
                                                        const isSelected = selectedRow === row;
                                                        const mergedNetworks = getMergedNetworks(row);
                                                        const platform = getPlatform(row);

                                                        return (
                                                            <div
                                                                key={`${groupKey}-${idx}`}
                                                                onClick={() => setSelectedRow(row)}
                                                                className={`px-3 py-2 border-t border-slate-100 cursor-pointer transition-colors ${
                                                                    isSelected
                                                                        ? 'bg-blue-100'
                                                                        : isActive
                                                                            ? 'bg-slate-100'
                                                                            : 'hover:bg-slate-50'
                                                                }`}
                                                            >
                                                                <div className="grid grid-cols-[90px_90px_1fr] gap-2 items-start">
                                                                    <span className={`inline-flex w-fit px-2 py-0.5 rounded-full text-[11px] font-semibold ${methodBadgeClass(getMethod(row))}`}>
                                                                        {getMethod(row)}
                                                                    </span>
                                                                    <span className="text-xs text-slate-500">{getVersion(row)}</span>
                                                                    <span className="text-sm text-slate-900 font-mono break-all">{getPath(row)}</span>
                                                                </div>
                                                                <div className="mt-1 text-xs text-slate-500 truncate">
                                                                    {getTargetName(row)} · {getTargetPath(row)}
                                                                </div>
                                                                {(row.__isMerged || (platform && platform !== '-')) && (
                                                                    <div className="mt-1 flex flex-wrap gap-1">
                                                                        {mergedNetworks.map((network, netIdx) => (
                                                                            <span
                                                                                key={`${groupKey}-${idx}-${network}-${netIdx}`}
                                                                                className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${networkBadgeClass(network)}`}
                                                                            >
                                                                                {network}
                                                                            </span>
                                                                        ))}
                                                                        {platform && platform !== '-' && (
                                                                            <span
                                                                                className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${platformBadgeClass(platform)}`}
                                                                                title={`Platform: ${platform}`}
                                                                            >
                                                                                {platform}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            <aside className="hidden lg:block">
                                <div className="sticky top-4 border border-slate-200 rounded-md bg-white p-4 max-h-[820px] overflow-auto">
                                    <DetailPanel row={selectedRow} />
                                </div>
                            </aside>
                        </div>
                    )}

                    {selectedRow && (
                        <div className="lg:hidden">
                            <button
                                onClick={() => setDrawerOpen(true)}
                                className="w-full px-4 py-2 bg-slate-800 text-white rounded-md text-sm"
                            >
                                Ver detalhe da operação selecionada
                            </button>
                        </div>
                    )}

                    {drawerOpen && selectedRow && (
                        <div className="lg:hidden fixed inset-0 bg-black/40 z-50 flex items-end">
                            <div className="bg-white w-full rounded-t-xl p-4 max-h-[90vh] overflow-auto">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-semibold">Detalhe</h3>
                                    <button
                                        onClick={() => setDrawerOpen(false)}
                                        className="px-3 py-1 text-sm border border-slate-300 rounded-md"
                                    >
                                        Fechar
                                    </button>
                                </div>
                                <DetailPanel row={selectedRow} />
                            </div>
                        </div>
                    )}
                </div>
            );
        }

        // Helper para download de arquivo
        function downloadFile(filename, content) {
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }

        function sanitizeFilename(str) {
            return str ? str.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'unknown';
        }

        const CURL_HISTORY_LIMIT = 40;
        const CURL_SPEC_HISTORY_KEY = 'openapi_toolbox_curl_saved_specs_v1';
        const CURL_XML_HISTORY_KEY = 'openapi_toolbox_curl_saved_xml_v1';

        function buildTimestampToken(date = new Date()) {
            const pad = (n, size = 2) => String(n).padStart(size, '0');
            return [
                date.getFullYear(),
                pad(date.getMonth() + 1),
                pad(date.getDate()),
                '_',
                pad(date.getHours()),
                pad(date.getMinutes()),
                pad(date.getSeconds()),
                '_',
                pad(date.getMilliseconds(), 3)
            ].join('');
        }

        function safeReadHistory(key) {
            try {
                const raw = localStorage.getItem(key);
                if (!raw) return [];
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                console.warn('Não foi possível ler histórico local:', e);
                return [];
            }
        }

        function upsertHistoryEntry(key, entry) {
            const list = safeReadHistory(key);
            const normalizedContent = (entry.content || '').trim();
            const existingIdx = list.findIndex(item => (item.content || '').trim() === normalizedContent);
            let updated;
            if (existingIdx >= 0) {
                const existing = list[existingIdx];
                const merged = {
                    ...existing,
                    ...entry,
                    id: existing.id,
                    createdAt: existing.createdAt || entry.createdAt
                };
                updated = [merged, ...list.filter((_, idx) => idx !== existingIdx)];
            } else {
                updated = [entry, ...list];
            }
            const trimmed = updated.slice(0, CURL_HISTORY_LIMIT);
            try {
                localStorage.setItem(key, JSON.stringify(trimmed));
            } catch (e) {
                console.warn('Não foi possível salvar histórico local:', e);
            }
            return trimmed;
        }

        // TAB 3: Gerador cURL
        function CurlGenerator({ csvData = [] }) {
            const [specText, setSpecText] = useState('');
            const [spec, setSpec] = useState(null);
            const [operations, setOperations] = useState([]);
            const [selectedOp, setSelectedOp] = useState(null);
            const [xmlText, setXmlText] = useState('');
            const [includeEmptyFields, setIncludeEmptyFields] = useState(false);
            const [bodyOnlyWithValues, setBodyOnlyWithValues] = useState(true);
            const [showMappingModal, setShowMappingModal] = useState(false);
            const [mappingData, setMappingData] = useState(null);
            const [curlOutput, setCurlOutput] = useState('');
            const [opSearchTerm, setOpSearchTerm] = useState('');
            const [dirHandle, setDirHandle] = useState(null);
            const [availableSpecs, setAvailableSpecs] = useState([]);
            const [availableXmls, setAvailableXmls] = useState([]);
            const [savedSpecs, setSavedSpecs] = useState([]);
            const [savedXmls, setSavedXmls] = useState([]);
            const [hideDeprecated, setHideDeprecated] = useState(true);
            const [highlightValidated, setHighlightValidated] = useState(false);
            const [specHighlightLang, setSpecHighlightLang] = useState('yaml');
            const [isEditingSpec, setIsEditingSpec] = useState(false);
            const [isEditingXml, setIsEditingXml] = useState(false);
            const [autoSuggestion, setAutoSuggestion] = useState(null);
            const [analysisTab, setAnalysisTab] = useState('signals');
            const [analysisExpanded, setAnalysisExpanded] = useState(false);
            const [autoFiltersEnabled, setAutoFiltersEnabled] = useState(true);
            const [suggestionFilters, setSuggestionFilters] = useState(null);
            const specHighlightRef = useRef(null);
            const xmlHighlightRef = useRef(null);
            const specTextareaRef = useRef(null);
            const xmlTextareaRef = useRef(null);

            useEffect(() => {
                setSavedSpecs(safeReadHistory(CURL_SPEC_HISTORY_KEY));
                setSavedXmls(safeReadHistory(CURL_XML_HISTORY_KEY));
            }, []);

            useEffect(() => {
                if (!highlightValidated) return;
                if (!isEditingSpec && specHighlightRef.current) {
                    specHighlightRef.current.textContent = specText || '';
                    specHighlightRef.current.className = specHighlightLang;
                    hljs.highlightElement(specHighlightRef.current);
                }
                if (!isEditingXml && xmlHighlightRef.current) {
                    xmlHighlightRef.current.textContent = xmlText || '';
                    xmlHighlightRef.current.className = 'xml';
                    hljs.highlightElement(xmlHighlightRef.current);
                }
            }, [highlightValidated, specText, xmlText, specHighlightLang, isEditingSpec, isEditingXml]);

            // Helper to extract version from path
            const extractVersion = (path) => {
                const match = path.match(/\/v(\d+)(\.\d+)?\//i);
                return match ? `v${match[1]}${match[2] || ''}` : '-';
            };

            const formatHistoryDate = (isoDate) => {
                if (!isoDate) return 'sem data';
                const date = new Date(isoDate);
                return Number.isNaN(date.getTime()) ? 'sem data' : date.toLocaleString();
            };

            const isAlreadySaved = (list, content) => {
                const normalized = (content || '').trim();
                if (!normalized) return true;
                return list.some(item => (item.content || '').trim() === normalized);
            };

            const syncOverlayScroll = (textareaRef, codeRef) => {
                const textarea = textareaRef.current;
                const codeEl = codeRef.current;
                const preEl = codeEl ? codeEl.parentElement : null;
                if (!textarea || !preEl) return;
                preEl.scrollTop = textarea.scrollTop;
                preEl.scrollLeft = textarea.scrollLeft;
            };

            const findHeaderIndexByKey = (headers, key) => {
                const normalizedKey = normalizeKey(key);
                return headers.findIndex((h) => normalizeKey(h.key) === normalizedKey);
            };

            const addOrMergeHeader = (headers, headerEntry) => {
                const idx = findHeaderIndexByKey(headers, headerEntry.key);
                if (idx === -1) {
                    headers.push({ ...headerEntry });
                    return;
                }

                const existing = headers[idx];
                const merged = { ...existing };
                merged.enabled = Boolean(existing.enabled) || Boolean(headerEntry.enabled);

                const existingValue = String(existing.value || '').trim();
                const incomingValue = String(headerEntry.value || '').trim();
                if (!existingValue && incomingValue) {
                    merged.value = incomingValue;
                }

                if ((!existing.description || !String(existing.description).trim()) && headerEntry.description) {
                    merged.description = headerEntry.description;
                }

                if (existing.removable === undefined && headerEntry.removable !== undefined) {
                    merged.removable = headerEntry.removable;
                }
                if (existing.locked === undefined && headerEntry.locked !== undefined) {
                    merged.locked = headerEntry.locked;
                }

                headers[idx] = merged;
            };

            const extractHeadersFromXmlLog = (xmlRaw) => {
                if (!xmlRaw || !xmlRaw.trim()) return [];
                const headers = [];
                const cleanedXml = xmlRaw.replace(/`\s*/g, '').replace(/\s*`/g, '');

                try {
                    const xmlDoc = parseXmlSafely(cleanedXml);
                    const allElements = Array.from(xmlDoc.getElementsByTagName('*'));
                    const headerNode = allElements.find((el) => normalizeKey(getLocalName(el)).includes('header'));

                    if (headerNode) {
                        const directChildren = Array.from(headerNode.childNodes || []).filter((n) => n.nodeType === 1);
                        directChildren.forEach((node) => {
                            const key = repairMojibake(getLocalName(node));
                            if (!key) return;
                            const hasNestedElements = Array.from(node.childNodes || []).some((n) => n.nodeType === 1);
                            const textValue = repairMojibake(node.textContent?.trim());
                            if (!hasNestedElements && textValue) {
                                headers.push({ key, value: textValue });
                            }
                        });
                    }
                } catch (e) {
                    // Ignore parser errors here; name/value fallback below may still work.
                }

                const pairMap = extractNameValuePairs(cleanedXml);
                Object.entries(pairMap).forEach(([key, value]) => {
                    if (!key || value === undefined || value === null || String(value).trim() === '') return;
                    headers.push({ key: repairMojibake(key), value: repairMojibake(value) });
                });

                const unique = [];
                headers.forEach((header) => {
                    const exists = unique.some((h) => normalizeKey(h.key) === normalizeKey(header.key));
                    if (!exists) unique.push(header);
                });
                return unique;
            };

            const XML_HEADER_CANONICAL_MAP = {
                process: 'X-process',
                etrackingid: 'X-eTrackingID',
                application: 'X-application'
            };

            const getCanonicalHeaderKeyFromXml = (rawKey) => {
                const normalized = normalizeKey(rawKey);
                return XML_HEADER_CANONICAL_MAP[normalized] || rawKey;
            };

            const isPromotedXmlHeader = (rawKey) => {
                const normalized = normalizeKey(rawKey);
                return Boolean(XML_HEADER_CANONICAL_MAP[normalized]);
            };

            const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const extractCanonicalHeaderValuesFromXml = (xmlRaw) => {
                const result = {};
                if (!xmlRaw || !String(xmlRaw).trim()) return result;
                const source = String(xmlRaw).replace(/`\s*/g, '').replace(/\s*`/g, '');

                const extractLocalTagValue = (tagName) => {
                    const safeTag = escapeRegex(tagName);
                    const headerMatch = source.match(new RegExp(`<(?:\\w+:)?Header\\b[\\s\\S]*?<\\/(?:\\w+:)?Header>`, 'i'));
                    if (headerMatch && headerMatch[0]) {
                        const insideHeader = headerMatch[0];
                        const m = insideHeader.match(new RegExp(`<(?:\\w+:)?${safeTag}\\b[^>]*>\\s*([^<]+?)\\s*<\\/(?:\\w+:)?${safeTag}>`, 'i'));
                        if (m && m[1]) return repairMojibake(m[1].trim());
                    }
                    const mGlobal = source.match(new RegExp(`<(?:\\w+:)?${safeTag}\\b[^>]*>\\s*([^<]+?)\\s*<\\/(?:\\w+:)?${safeTag}>`, 'i'));
                    return mGlobal && mGlobal[1] ? repairMojibake(mGlobal[1].trim()) : '';
                };

                const applicationValue = extractLocalTagValue('application');
                if (applicationValue) result['X-application'] = applicationValue;

                const processValue = extractLocalTagValue('process');
                if (processValue) result['X-process'] = processValue;

                const eTrackingValue = extractLocalTagValue('eTrackingID');
                if (eTrackingValue) result['X-eTrackingID'] = eTrackingValue;

                return result;
            };

            const SIGNAL_ENTITIES = ['Person', 'Account', 'Contract', 'Product', 'Order', 'Billing', 'Asset', 'Party', 'Customer', 'Subscription', 'Ticket', 'Case', 'Incident', 'Payment'];
            const INTENT_KEYWORDS = ['manage', 'create', 'update', 'search', 'delete', 'activate', 'deactivate', 'validate', 'verify', 'migrate', 'sync'];

            const normalizeKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const normalizePath = (path) => String(path || '').trim().replace(/\/+$/, '').toLowerCase();
            const splitTokens = (value) => String(value || '')
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .replace(/[^a-zA-Z0-9]+/g, ' ')
                .toLowerCase()
                .trim()
                .split(/\s+/)
                .filter(Boolean);

            const toTokenSet = (value) => new Set(splitTokens(value));
            const jaccardSimilarity = (left, right) => {
                const leftSet = toTokenSet(left);
                const rightSet = toTokenSet(right);
                if (!leftSet.size || !rightSet.size) return 0;
                let intersection = 0;
                for (const token of leftSet) {
                    if (rightSet.has(token)) intersection += 1;
                }
                const union = new Set([...leftSet, ...rightSet]).size;
                return union ? (intersection / union) : 0;
            };

            const getCsvField = (row, candidateNames) => {
                if (!row) return '';
                const keyMap = Object.keys(row).reduce((acc, key) => {
                    acc[normalizeKey(key)] = key;
                    return acc;
                }, {});

                for (const name of candidateNames) {
                    const normalized = normalizeKey(name);
                    const realKey = keyMap[normalized];
                    if (!realKey) continue;
                    const value = row[realKey];
                    if (value !== undefined && value !== null && String(value).trim() !== '') {
                        return String(value).trim();
                    }
                }
                return '';
            };

            const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const pathMatchScore = (csvPath, opPath) => {
                const csvNormalized = normalizePath(csvPath);
                const opNormalized = normalizePath(opPath);
                if (!csvNormalized || !opNormalized) return 0;
                if (csvNormalized === opNormalized) return 20;

                const csvPattern = '^' + escapeRegExp(csvNormalized)
                    .replace(/\\\*/g, '[^/]+')
                    .replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$';
                const opPattern = '^' + escapeRegExp(opNormalized)
                    .replace(/\\\*/g, '[^/]+')
                    .replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$';

                if (new RegExp(csvPattern, 'i').test(opNormalized)) return 16;
                if (new RegExp(opPattern, 'i').test(csvNormalized)) return 14;
                if (opNormalized.includes(csvNormalized) || csvNormalized.includes(opNormalized)) return 10;

                const csvBase = csvNormalized.split('/').slice(0, 4).join('/');
                const opBase = opNormalized.split('/').slice(0, 4).join('/');
                if (csvBase && opBase && csvBase === opBase) return 8;

                return 0;
            };

            const extractNameValuePairs = (xmlContent) => {
                const result = {};
                const regex = /<[^>]*:?name[^>]*>\s*([^<]+?)\s*<\/[^>]+>\s*<[^>]*:?value[^>]*>\s*([^<]*?)\s*<\/[^>]+>/ig;
                let match = regex.exec(xmlContent);
                while (match) {
                    const rawName = repairMojibake(match[1]?.trim());
                    const rawValue = repairMojibake(match[2]?.trim());
                    if (rawName) result[rawName] = rawValue;
                    match = regex.exec(xmlContent);
                }
                return result;
            };

            const findXmlFieldValueInScope = (scopeRoot, targetFieldNorm) => {
                if (!scopeRoot || !targetFieldNorm) return '';
                const stack = [scopeRoot];

                while (stack.length > 0) {
                    const node = stack.shift();
                    if (!node || node.nodeType !== 1) continue;

                    // 1) Attribute match (highest priority)
                    if (node.attributes && node.attributes.length > 0) {
                        for (let i = 0; i < node.attributes.length; i++) {
                            const attr = node.attributes[i];
                            const attrNameNorm = normalizeKey(getLocalName(attr) || attr.name);
                            if (attrNameNorm !== targetFieldNorm) continue;
                            const attrValue = repairMojibake(attr.value?.trim());
                            if (attrValue) return attrValue;
                        }
                    }

                    // 2) Generic <name>/<value> pair in current node
                    const nameNode = findChildByLocalName(node, 'name');
                    const valueNode = findChildByLocalName(node, 'value');
                    if (nameNode && valueNode) {
                        const pairName = normalizeKey(repairMojibake(nameNode.textContent?.trim()));
                        if (pairName === targetFieldNorm) {
                            const pairValue = repairMojibake(valueNode.textContent?.trim());
                            if (pairValue) return pairValue;
                        }
                    }

                    // 3) Element name match (only if it is effectively a leaf with text)
                    const nodeNameNorm = normalizeKey(getLocalName(node));
                    if (nodeNameNorm === targetFieldNorm) {
                        const hasElementChildren = Array.from(node.childNodes || []).some((c) => c.nodeType === 1);
                        const textValue = repairMojibake(node.textContent?.trim());
                        if (!hasElementChildren && textValue) return textValue;
                    }

                    const children = Array.from(node.childNodes || []).filter((c) => c.nodeType === 1);
                    stack.push(...children);
                }

                return '';
            };

            const extractParamValueFromXml = (xmlRaw, fieldName) => {
                if (!xmlRaw || !fieldName) return '';
                const targetFieldNorm = normalizeKey(fieldName);
                if (!targetFieldNorm) return '';

                const cleanedXml = String(xmlRaw).replace(/`\s*/g, '').replace(/\s*`/g, '');
                try {
                    const xmlDoc = parseXmlSafely(cleanedXml);
                    const allElements = Array.from(xmlDoc.getElementsByTagName('*'));
                    const bodyNode = allElements.find((el) => normalizeKey(getLocalName(el)) === 'body');

                    // First search only in SOAP body payload to avoid header contamination.
                    if (bodyNode) {
                        const bodyChildren = Array.from(bodyNode.childNodes || []).filter((n) => n.nodeType === 1);
                        const primaryScopes = bodyChildren.length > 0 ? bodyChildren : [bodyNode];
                        for (const scope of primaryScopes) {
                            const value = findXmlFieldValueInScope(scope, targetFieldNorm);
                            if (value) return value;
                        }
                    }

                    // Fallback to full document search.
                    const root = xmlDoc.documentElement;
                    if (root) {
                        const fallbackValue = findXmlFieldValueInScope(root, targetFieldNorm);
                        if (fallbackValue) return fallbackValue;
                    }
                } catch (e) {
                    // Fall through to regex name/value fallback.
                }

                // Regex fallback scoped to Body first, then global document:
                // 1) attribute, 2) direct element text.
                const safeField = escapeRegex(fieldName);
                const bodyMatch = cleanedXml.match(/<(?:\w+:)?Body\b[\s\S]*?<\/(?:\w+:)?Body>/i);
                const searchScopes = [];
                if (bodyMatch && bodyMatch[0]) searchScopes.push(bodyMatch[0]);
                searchScopes.push(cleanedXml);

                for (const scope of searchScopes) {
                    const attrMatch = scope.match(new RegExp(`\\b${safeField}\\s*=\\s*"(.*?)"`, 'i'));
                    if (attrMatch && attrMatch[1]) {
                        const attrValue = repairMojibake(attrMatch[1].trim());
                        if (attrValue) return attrValue;
                    }
                    const elementMatch = scope.match(new RegExp(`<(?:\\w+:)?${safeField}\\b[^>]*>\\s*([^<]+?)\\s*<\\/(?:\\w+:)?${safeField}>`, 'i'));
                    if (elementMatch && elementMatch[1]) {
                        const elementValue = repairMojibake(elementMatch[1].trim());
                        if (elementValue) return elementValue;
                    }
                }

                const pairMap = extractNameValuePairs(cleanedXml);
                for (const [key, value] of Object.entries(pairMap)) {
                    if (normalizeKey(key) !== targetFieldNorm) continue;
                    const repaired = repairMojibake(value?.trim());
                    if (repaired) return repaired;
                }

                return '';
            };

            const extractDomainService = (text) => {
                if (!text) return { domain: '', service: '', namespace: '' };
                const source = String(text);
                const patterns = [
                    /urn:[^:]*:([^\/:\s]+)\/([^\/:\s]+)(?:\/data)?/i,
                    /\/soa\/[^\/\s]*\/([^\/\s]+)\/([^\/\s]+)/i,
                    /\/services\/([^\/\s]+)\/([^\/\s]+)/i,
                    /\/backend\/([^\/\s]+)/i
                ];
                for (const pattern of patterns) {
                    const m = source.match(pattern);
                    if (!m) continue;
                    if (pattern === patterns[3]) {
                        return { domain: '', service: repairMojibake(m[1] || ''), namespace: source };
                    }
                    return {
                        domain: repairMojibake(m[1] || ''),
                        service: repairMojibake(m[2] || ''),
                        namespace: source
                    };
                }
                return { domain: '', service: '', namespace: '' };
            };

            const extractTargetServiceFromLog = (xmlContent) => {
                if (!xmlContent || !xmlContent.trim()) return '';
                const source = xmlContent;
                const pairs = extractNameValuePairs(source);
                const targetServicePair = Object.entries(pairs).find(([name]) => normalizeKey(name).includes('targetservice'));
                if (targetServicePair && targetServicePair[1]) {
                    return repairMojibake(targetServicePair[1].trim());
                }

                const pairRegex = /<[^>]*:?name[^>]*>\s*TARGET[_\s-]?SERVICE\s*<\/[^>]+>\s*<[^>]*:?value[^>]*>\s*([^<\n]+)\s*<\/[^>]+>/i;
                const pairMatch = source.match(pairRegex);
                if (pairMatch && pairMatch[1]) {
                    return repairMojibake(pairMatch[1].trim());
                }

                const textPatterns = [
                    /<[^>]*:?targetservice[^>]*>\s*([^<\n]+)\s*<\/[^>]+>/i,
                    /<[^>]*:?target_service[^>]*>\s*([^<\n]+)\s*<\/[^>]+>/i,
                    /<[^>]*:?servicename[^>]*>\s*([^<\n]+)\s*<\/[^>]+>/i,
                    /Target Service\s*[:=]\s*([^\r\n<]+)/i
                ];
                for (const pattern of textPatterns) {
                    const m = source.match(pattern);
                    if (m && m[1]) {
                        return repairMojibake(m[1].trim());
                    }
                }

                try {
                    const doc = parseXmlSafely(source);
                    const nodes = doc.getElementsByTagName('*');
                    const candidateNames = new Set(['targetservice', 'target_service', 'servicename']);
                    for (let i = 0; i < nodes.length; i++) {
                        const node = nodes[i];
                        const localName = normalizeKey(getLocalName(node));
                        if (!candidateNames.has(localName)) continue;
                        const value = repairMojibake(node.textContent?.trim());
                        if (value) return value;
                    }
                } catch (e) {
                    // Ignore parser errors for partially pasted logs.
                }

                return '';
            };

            const parseSignalsFromLog = (xmlContent) => {
                const source = String(xmlContent || '');
                const pairs = extractNameValuePairs(source);
                const protocol = /soap|xmlsoap|soapenv|soap-env/i.test(source)
                    ? 'soap'
                    : /^\s*\{/.test(source) ? 'rest-json' : 'xml';

                const namespaceValues = [];
                const nsRegex = /xmlns(?::[\w-]+)?="([^"]+)"/ig;
                let nsMatch = nsRegex.exec(source);
                while (nsMatch) {
                    namespaceValues.push(repairMojibake(nsMatch[1]));
                    nsMatch = nsRegex.exec(source);
                }

                const namespaceCandidate = namespaceValues.find((ns) => /urn:|\/soa\/|\/services\/|\/backend\//i.test(ns)) || '';
                const nsParts = extractDomainService(namespaceCandidate);
                const targetService = extractTargetServiceFromLog(source);

                const entityHits = SIGNAL_ENTITIES.filter((entity) => {
                    const regex = new RegExp(`\\b${entity}\\b`, 'i');
                    return regex.test(source);
                });

                const intents = INTENT_KEYWORDS.filter((intent) => {
                    const regex = new RegExp(`\\b${intent}\\b`, 'i');
                    return regex.test(source);
                });

                const weakHeaderKeys = ['process', 'servicename', 'operation', 'flow', 'interface', 'system', 'module', 'action_type', 'correlation_id'];
                const weakHeaders = {};
                Object.entries(pairs).forEach(([name, value]) => {
                    const normalizedName = normalizeKey(name);
                    if (!weakHeaderKeys.some((k) => normalizedName.includes(normalizeKey(k)))) return;
                    weakHeaders[name] = value;
                });

                return {
                    protocol,
                    namespace: namespaceCandidate,
                    domain: nsParts.domain,
                    service: nsParts.service,
                    targetService,
                    payloadEntities: entityHits,
                    intents,
                    headers: weakHeaders
                };
            };

            const extractVersionNumber = (value) => {
                const m = String(value || '').match(/v(\d+(?:\.\d+)?)/i);
                if (!m) return 0;
                return Number(m[1]) || 0;
            };

            const operationFamilyKey = (op) => normalizePath(op.path).replace(/\/v\d+(\.\d+)?\//i, '/v*/');

            const scoreCandidate = (op, row, signals, maxVersionMap) => {
                if (op.operation?.deprecated) return null;
                const rowStatus = getCsvField(row, ['STATUS', 'status', 'Status']).toLowerCase();
                if (rowStatus && rowStatus !== 'available') return null;

                const rowMethod = getCsvField(row, ['Method', 'METHOD', 'method']).toUpperCase();
                const rowPath = getCsvField(row, ['Path', 'PATH', 'path']);
                const rowVersion = getCsvField(row, ['Version', 'VERSION', 'version']);
                const rowTargetService = getCsvField(row, ['Target Service', 'targetService', 'serviceName']);
                const rowTargetPath = getCsvField(row, ['Target Path', 'targetPath', 'backendPath']);

                const opVersion = extractVersion(op.path);
                const pathScore = pathMatchScore(rowPath, op.path);
                const methodBoost = rowMethod && rowMethod === op.method ? 8 : 0;

                const serviceProbe = signals.targetService || signals.service;
                const serviceSimilarity = serviceProbe ? jaccardSimilarity(serviceProbe, rowTargetService) : 0;
                const serviceScore = serviceSimilarity >= 0.95 ? 30 : serviceSimilarity >= 0.65 ? 22 : serviceSimilarity >= 0.4 ? 12 : 0;

                let namespaceScore = 0;
                const namespaceNormalized = normalizeKey(signals.namespace);
                const targetPathNormalized = normalizeKey(rowTargetPath);
                if (namespaceNormalized && targetPathNormalized && (targetPathNormalized.includes(namespaceNormalized) || namespaceNormalized.includes(targetPathNormalized))) {
                    namespaceScore = 50;
                } else if (signals.service && targetPathNormalized.includes(normalizeKey(signals.service))) {
                    namespaceScore = 32;
                }

                let domainScore = 0;
                if (signals.domain) {
                    const domainNorm = normalizeKey(signals.domain);
                    if (normalizeKey(rowTargetPath).includes(domainNorm) || normalizeKey(rowTargetService).includes(domainNorm)) {
                        domainScore = 15;
                    }
                }

                const opText = `${op.path} ${op.operationId || ''} ${op.operation?.summary || ''} ${(op.operation?.tags || []).join(' ')} ${rowTargetPath} ${rowTargetService}`;
                const payloadOverlap = signals.payloadEntities.length
                    ? signals.payloadEntities.filter((entity) => new RegExp(`\\b${entity}\\b`, 'i').test(opText)).length
                    : 0;
                const payloadScore = signals.payloadEntities.length
                    ? Math.min(15, Math.round((payloadOverlap / signals.payloadEntities.length) * 15))
                    : 0;

                const intentOverlap = signals.intents.length
                    ? signals.intents.filter((intent) => new RegExp(`\\b${intent}\\b`, 'i').test(opText)).length
                    : 0;
                const verbScore = signals.intents.length
                    ? Math.min(10, Math.round((intentOverlap / signals.intents.length) * 10))
                    : 0;

                const headerHintValues = Object.values(signals.headers || {}).filter(Boolean);
                const headerScore = headerHintValues.some((hint) => {
                    const token = String(hint).toLowerCase().trim();
                    if (token.length < 3) return false;
                    return opText.toLowerCase().includes(token);
                }) ? 5 : 0;

                let versionScore = 0;
                const familyKey = `${op.method}:${operationFamilyKey(op)}`;
                const bestFamilyVersion = maxVersionMap[familyKey] || 0;
                const currentVersion = extractVersionNumber(opVersion);
                if (currentVersion && currentVersion === bestFamilyVersion) versionScore = 5;
                if (currentVersion && bestFamilyVersion && currentVersion < bestFamilyVersion) versionScore -= 10;
                if (rowVersion && opVersion && String(rowVersion).toLowerCase() === String(opVersion).toLowerCase()) versionScore += 3;

                const deprecatedPenalty = 0;
                const hardEvidence = Math.max(namespaceScore, serviceScore, pathScore + methodBoost);
                if (hardEvidence < 12) return null;

                const total = namespaceScore + serviceScore + domainScore + payloadScore + verbScore + headerScore + versionScore + pathScore + methodBoost + deprecatedPenalty;
                const confidence = Math.max(0, Math.min(99, Math.round((total / 156) * 100)));

                return {
                    op,
                    row,
                    total,
                    confidence,
                    details: {
                        namespaceScore,
                        serviceScore,
                        domainScore,
                        payloadScore,
                        verbScore,
                        headerScore,
                        versionScore,
                        pathScore,
                        methodBoost,
                        deprecatedPenalty
                    },
                    mapped: {
                        targetService: rowTargetService,
                        targetPath: rowTargetPath
                    },
                    rowStatus,
                    opVersion
                };
            };

            const candidateKey = (op) => `${op.method}:${op.path}`;

            const buildDecisionReasons = (details) => {
                if (!details) return [];
                return [
                    { label: 'Namespace compatível com targetPath', score: details.namespaceScore },
                    { label: 'Serviço backend semelhante', score: details.serviceScore },
                    { label: 'Domínio compatível', score: details.domainScore },
                    { label: 'Entidades do payload coincidem', score: details.payloadScore },
                    { label: 'Verbo/intenção compatível', score: details.verbScore },
                    { label: 'Path/method com boa correspondência', score: details.pathScore + details.methodBoost },
                    { label: 'Hints de headers/metadados', score: details.headerScore }
                ]
                    .filter((item) => item.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 3)
                    .map((item) => item.label);
            };

            const formatSuggestionPayload = (best, ranked, signals) => {
                const alternatives = ranked.slice(1, 4).map((candidate) => ({
                    method: candidate.op.method,
                    path: candidate.op.path,
                    targetService: candidate.mapped.targetService || '',
                    targetPath: candidate.mapped.targetPath || '',
                    confidence: candidate.confidence,
                    details: candidate.details,
                    status: candidate.rowStatus || 'unknown',
                    version: candidate.opVersion || extractVersion(candidate.op.path)
                }));

                const suggestionFiltersPayload = {
                    domain: signals.domain || '',
                    service: signals.targetService || signals.service || '',
                    version: best.opVersion || extractVersion(best.op.path),
                    status: 'available',
                    candidateKeys: ranked.slice(0, 12).map((candidate) => candidateKey(candidate.op))
                };

                return {
                    type: best.confidence < 80 ? 'warning' : 'success',
                    title: best.confidence < 80 ? 'Correspondência parcial' : 'Operação sugerida',
                    message: `${best.op.method} ${best.op.path}`,
                    confidence: best.confidence,
                    reasons: buildDecisionReasons(best.details),
                    details: {
                        bestMatch: {
                            method: best.op.method,
                            path: best.op.path,
                            targetService: best.mapped.targetService || '',
                            targetPath: best.mapped.targetPath || '',
                            confidence: best.confidence
                        },
                        ranking: ranked.slice(0, 6).map((candidate) => ({
                            method: candidate.op.method,
                            path: candidate.op.path,
                            targetService: candidate.mapped.targetService || '',
                            targetPath: candidate.mapped.targetPath || '',
                            confidence: candidate.confidence,
                            version: candidate.opVersion || extractVersion(candidate.op.path),
                            status: candidate.rowStatus || 'unknown',
                            namespace: candidate.details.namespaceScore > 0,
                            payload: candidate.details.payloadScore > 0,
                            details: candidate.details
                        })),
                        alternatives,
                        signalsExtracted: {
                            protocol: signals.protocol || '',
                            namespace: signals.namespace || '',
                            domain: signals.domain || '',
                            service: signals.targetService || signals.service || '',
                            payloadEntities: signals.payloadEntities || [],
                            headers: signals.headers || {}
                        },
                        rawOutput: {
                            scoredCandidates: ranked.map((candidate) => ({
                                method: candidate.op.method,
                                path: candidate.op.path,
                                confidence: candidate.confidence,
                                total: candidate.total,
                                details: candidate.details,
                                targetService: candidate.mapped.targetService,
                                targetPath: candidate.mapped.targetPath
                            }))
                        }
                    },
                    suggestionFilters: suggestionFiltersPayload
                };
            };

            const matchByServiceOrDomain = (op, filterState) => {
                if (!filterState) return true;
                const opText = `${op.path} ${op.operationId || ''} ${(op.operation?.tags || []).join(' ')} ${op.operation?.summary || ''}`.toLowerCase();
                const domainOk = !filterState.domain || opText.includes(String(filterState.domain).toLowerCase());
                const serviceTokens = splitTokens(filterState.service || '');
                const serviceOk = serviceTokens.length === 0 || serviceTokens.some((token) => token.length > 2 && opText.includes(token));
                const versionOk = !filterState.version || extractVersion(op.path).toLowerCase() === String(filterState.version).toLowerCase();
                return domainOk && serviceOk && versionOk;
            };

            const filterOperationWithSuggestion = (op) => {
                if (!autoFiltersEnabled || !suggestionFilters) return true;
                if (!matchByServiceOrDomain(op, suggestionFilters)) return false;
                if (Array.isArray(suggestionFilters.candidateKeys) && suggestionFilters.candidateKeys.length > 0) {
                    return suggestionFilters.candidateKeys.includes(candidateKey(op));
                }
                return true;
            };

            const dismissSuggestionFilter = (filterKey) => {
                if (!suggestionFilters) return;
                if (filterKey === 'all') {
                    setAutoFiltersEnabled(false);
                    return;
                }
                setSuggestionFilters((prev) => {
                    if (!prev) return prev;
                    return { ...prev, [filterKey]: '' };
                });
            };

            const getAppliedFilterChips = () => {
                if (!autoFiltersEnabled || !suggestionFilters) return [];
                const chips = [];
                if (suggestionFilters.domain) chips.push({ key: 'domain', label: suggestionFilters.domain });
                if (suggestionFilters.service) chips.push({ key: 'service', label: suggestionFilters.service });
                if (suggestionFilters.version) chips.push({ key: 'version', label: suggestionFilters.version });
                if (suggestionFilters.status) chips.push({ key: 'status', label: suggestionFilters.status });
                return chips;
            };

            const getConfidenceTone = (confidence) => {
                if (confidence >= 85) return 'bg-emerald-500';
                if (confidence >= 70) return 'bg-amber-500';
                return 'bg-rose-500';
            };

            const getMethodPillClass = (method) => {
                if (method === 'GET') return 'bg-green-100 text-green-800';
                if (method === 'POST') return 'bg-blue-100 text-blue-800';
                if (method === 'PUT') return 'bg-yellow-100 text-yellow-800';
                if (method === 'DELETE') return 'bg-red-100 text-red-800';
                return 'bg-gray-100 text-gray-800';
            };

            useEffect(() => {
                const xmlCandidate = xmlText?.trim();
                if (!xmlCandidate || !operations.length || !csvData.length) {
                    setAutoSuggestion(null);
                    setSuggestionFilters(null);
                    return;
                }

                const signals = parseSignalsFromLog(xmlCandidate);
                const maxVersionMap = {};
                operations.forEach((op) => {
                    const familyKey = `${op.method}:${operationFamilyKey(op)}`;
                    const versionValue = extractVersionNumber(extractVersion(op.path));
                    if (!maxVersionMap[familyKey] || versionValue > maxVersionMap[familyKey]) {
                        maxVersionMap[familyKey] = versionValue;
                    }
                });

                const rankedByOperation = new Map();
                for (const op of operations) {
                    for (const row of csvData) {
                        const scored = scoreCandidate(op, row, signals, maxVersionMap);
                        if (!scored) continue;
                        const key = `${op.method}:${op.path}`;
                        const existing = rankedByOperation.get(key);
                        if (!existing || scored.total > existing.total) {
                            rankedByOperation.set(key, scored);
                        }
                    }
                }

                const ranked = [...rankedByOperation.values()].sort((a, b) => b.total - a.total);
                if (!ranked.length) {
                    setAutoSuggestion({
                        type: 'warning',
                        title: 'Sem correspondência forte',
                        message: 'Sinais insuficientes para mapear operação com confiança.',
                        confidence: 0,
                        reasons: [],
                        details: {
                            status: 'ambiguous',
                            reason: 'No candidate scored with minimum hard evidence.',
                            topCandidates: [],
                            signalsExtracted: signals
                        }
                    });
                    setSuggestionFilters(null);
                    return;
                }

                const best = ranked[0];

                if (best.confidence < 60) {
                    const partialPayload = formatSuggestionPayload(best, ranked, signals);
                    setAutoSuggestion({
                        ...partialPayload,
                        type: 'warning',
                        title: 'Correspondência ambígua',
                        message: `${best.op.method} ${best.op.path}`,
                        details: {
                            ...partialPayload.details,
                            status: 'ambiguous',
                            reason: 'Best candidate below confidence threshold (60).',
                            topCandidates: partialPayload.details.ranking
                        }
                    });
                    setSuggestionFilters(partialPayload.suggestionFilters);
                    setAutoFiltersEnabled(true);
                    return;
                }

                if (!selectedOp || selectedOp.path !== best.op.path || selectedOp.method !== best.op.method) {
                    setSelectedOp(best.op);
                }

                const successPayload = formatSuggestionPayload(best, ranked, signals);
                setAutoSuggestion(successPayload);
                setSuggestionFilters(successPayload.suggestionFilters);
                setAutoFiltersEnabled(true);
                setAnalysisTab('signals');
                setAnalysisExpanded(false);
            }, [xmlText, operations, csvData, selectedOp]);

            const saveValidatedSpecToLocalHistory = (parsedSpec, sourceText, extension) => {
                const title = parsedSpec?.info?.title || 'openapi_spec';
                const version = parsedSpec?.info?.version || 'v1';
                const autoName = `${sanitizeFilename(title)}_${sanitizeFilename(version)}_${buildTimestampToken()}.${extension}`;
                const entry = {
                    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: autoName,
                    createdAt: new Date().toISOString(),
                    content: sourceText,
                    title,
                    version
                };
                const nextList = upsertHistoryEntry(CURL_SPEC_HISTORY_KEY, entry);
                setSavedSpecs(nextList);
                return autoName;
            };

            const saveValidatedXmlToLocalHistory = (sourceText, selectedOperation, parsedSpec) => {
                const title = parsedSpec?.info?.title || 'openapi_spec';
                const opId = selectedOperation?.operationId || `${selectedOperation?.method || 'op'}_${selectedOperation?.path || 'request'}`;
                const autoName = `${sanitizeFilename(title)}_${sanitizeFilename(opId)}_example_${buildTimestampToken()}.xml`;
                const entry = {
                    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: autoName,
                    createdAt: new Date().toISOString(),
                    content: sourceText,
                    operationId: selectedOperation?.operationId || ''
                };
                const nextList = upsertHistoryEntry(CURL_XML_HISTORY_KEY, entry);
                setSavedXmls(nextList);
                return autoName;
            };

            // Connect to local folder
            const handleConnectFolder = async () => {
                try {
                    const handle = await window.showDirectoryPicker();
                    setDirHandle(handle);
                    await refreshFileList(handle);
                } catch (e) {
                    console.error('Erro ao conectar pasta:', e);
                }
            };

            // List files in folder
            const refreshFileList = async (handle) => {
                if (!handle) return;
                const specs = [];
                const xmls = [];
                for await (const entry of handle.values()) {
                    if (entry.kind === 'file') {
                        if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml') || entry.name.endsWith('.json')) {
                            specs.push(entry);
                        } else if (entry.name.endsWith('.xml')) {
                            xmls.push(entry);
                        }
                    }
                }
                setAvailableSpecs(specs);
                setAvailableXmls(xmls);
            };

            // Read file content
            const handleLoadFile = async (fileHandle, type) => {
                try {
                    const file = await fileHandle.getFile();
                    const text = await file.text();
                    if (type === 'spec') {
                        setSpecText(text);
                        // Optional: auto-validate
                    } else if (type === 'xml') {
                        setXmlText(text);
                    }
                } catch (e) {
                    alert('Erro ao ler arquivo: ' + e.message);
                }
            };

            // Save file helper (local or download)
            const saveFile = async (filename, content) => {
                if (dirHandle) {
                    try {
                        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(content);
                        await writable.close();
                        // Refresh list to show new file
                        await refreshFileList(dirHandle);
                        return true;
                    } catch (e) {
                        console.error('Erro ao salvar na pasta:', e);
                        // Fallback to download
                        downloadFile(filename, content);
                    }
                } else {
                    downloadFile(filename, content);
                }
            };

            const handleLoadSpec = () => {
                if (!specText.trim()) return;
                // Keep editors readable/editable after validation.
                setIsEditingSpec(true);
                setIsEditingXml(true);

                let parsed;
                let specExtension = 'yaml';
                try {
                    const jsonResult = validateJSON(specText);
                    if (jsonResult.valid) {
                        parsed = JSON.parse(specText);
                        specExtension = 'json';
                    } else {
                        const yamlResult = validateYAML(specText);
                        if (!yamlResult.valid) {
                            alert('Spec inválida');
                            return;
                        }
                        parsed = parseYAML(specText);
                    }
                } catch (e) {
                    alert(`Erro: ${e.message}`);
                    return;
                }

                setSpec(parsed);
                setSpecHighlightLang(specExtension === 'json' ? 'json' : 'yaml');
                setHighlightValidated(true);
                setIsEditingSpec(true);
                setIsEditingXml(true);

                // Perguntar se quer guardar novos pastes validados (spec e xml)
                const specIsNew = !isAlreadySaved(savedSpecs, specText);
                const xmlCandidate = xmlText.trim();
                const xmlLooksValid = Boolean(xmlCandidate);
                const xmlIsNew = xmlLooksValid && !isAlreadySaved(savedXmls, xmlCandidate);

                if (specIsNew) {
                    const shouldSaveSpec = window.confirm('Guardar esta Spec validada para uso futuro?');
                    if (shouldSaveSpec) {
                        try {
                            const generatedSpecName = saveValidatedSpecToLocalHistory(parsed, specText, specExtension);
                            saveFile(generatedSpecName, specText);
                        } catch (e) {
                            console.error('Erro ao guardar spec:', e);
                        }
                    }
                }

                if (xmlIsNew) {
                    try {
                        parseXmlSafely(xmlCandidate);
                        const shouldSaveXml = window.confirm('Guardar também o XML atualmente colado como exemplo validado?');
                        if (shouldSaveXml) {
                            const generatedXmlName = saveValidatedXmlToLocalHistory(xmlText, selectedOp, parsed);
                            saveFile(generatedXmlName, xmlText);
                        }
                    } catch (e) {
                        console.warn('XML atual não é válido para guardar no validar spec:', e);
                    }
                }

                const ops = [];
                if (parsed.paths) {
                    for (const [path, methods] of Object.entries(parsed.paths)) {
                        for (const [method, operation] of Object.entries(methods)) {
                            if (!['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) continue;
                            ops.push({
                                path,
                                method: method.toUpperCase(),
                                operation,
                                operationId: operation.operationId || `${method.toUpperCase()} ${path}`
                            });
                        }
                    }
                }
                setOperations(ops);
            };

            const handlePrepareMapping = () => {
                if (!selectedOp || !xmlText.trim()) {
                    alert('Selecione uma operação e cole XML de exemplo');
                    return;
                }

                const op = selectedOp.operation;
                const mapping = {
                    pathParams: [],
                    queryParams: [],
                    headers: [],
                    body: null
                };

                // Path params
                const pathParams = selectedOp.path.match(/\{([^}]+)\}/g) || [];
                pathParams.forEach(param => {
                    const name = param.replace(/[{}]/g, '');
                    const paramDef = op.parameters?.find(p => p.name === name && p.in === 'path');
                    let value = '';
                    // Extrair do XML (prioriza body/atributos e evita colisão com header metadata)
                    value = extractParamValueFromXml(xmlText, name);
                    mapping.pathParams.push({
                        key: name,
                        value: value || (paramDef?.example || paramDef?.default || ''),
                        enabled: true
                    });
                });

                // Query params
                if (op.parameters) {
                    op.parameters
                        .filter(p => p.in === 'query')
                        .forEach(p => {
                            let value = p.example || p.default || '';
                            const valueFromXml = extractParamValueFromXml(xmlText, p.name);
                            if (valueFromXml) value = valueFromXml;
                            mapping.queryParams.push({
                                key: p.name,
                                value,
                                enabled: true,
                                description: p.description || ''
                            });
                        });
                }

                // Headers default
                const defaultHeaders = [
                    { key: 'Traceparent', value: '{{$guid}}' },
                    { key: 'X-Flow-ID', value: '{{$guid}}' },
                    { key: 'X-application', value: 'POSTMAN' },
                    { key: 'X-originalApplication', value: 'POSTMAN' },
                    { key: 'X-process', value: 'Testing' },
                    { key: 'X-user', value: 'U80063362' },
                    { key: 'Content-Type', value: 'application/json' },
                    { key: 'Accept', value: 'application/json' },
                    { key: 'X-eTrackingID', value: '' }
                ];

                // Headers obrigatórios do YAML (devem aparecer primeiro)
                if (op.parameters) {
                    op.parameters
                        .filter(p => p.in === 'header' && p.required && !p.deprecated)
                        .forEach(p => {
                            addOrMergeHeader(mapping.headers, {
                                key: p.name,
                                value: p.example || p.default || '',
                                enabled: true,
                                description: `[OBRIGATÓRIO] ${p.description || ''}`,
                                source: 'yaml-required',
                                removable: false,
                                locked: true
                            });
                        });
                }

                // Headers default base
                defaultHeaders.forEach(h => {
                    addOrMergeHeader(mapping.headers, {
                        key: h.key,
                        value: h.value,
                        enabled: true,
                        description: '',
                        source: 'default',
                        removable: true,
                        locked: false
                    });
                });

                // Headers encontrados no XML (listados mas desmarcados)
                const xmlHeaders = extractHeadersFromXmlLog(xmlText);
                xmlHeaders.forEach(h => {
                    const canonicalKey = getCanonicalHeaderKeyFromXml(h.key);
                    const incomingValue = String(h.value || '').trim();
                    const promoted = isPromotedXmlHeader(h.key);
                    const existingIdx = findHeaderIndexByKey(mapping.headers, canonicalKey);

                    if (promoted && existingIdx >= 0) {
                        if (incomingValue) {
                            mapping.headers[existingIdx].value = incomingValue;
                        }
                        const tag = '[XML] Valor mapeado automaticamente do log';
                        const existingDesc = mapping.headers[existingIdx].description || '';
                        if (!existingDesc.includes(tag)) {
                            mapping.headers[existingIdx].description = existingDesc
                                ? `${tag} ${existingDesc}`
                                : tag;
                        }
                        return;
                    }

                    addOrMergeHeader(mapping.headers, {
                        key: canonicalKey,
                        value: incomingValue,
                        enabled: false,
                        description: '[XML] Header detetado no log',
                        source: 'xml',
                        removable: true,
                        locked: false
                    });
                });

                // Override canonic headers directly from log fields when present.
                const canonicalHeaderValues = extractCanonicalHeaderValuesFromXml(xmlText);
                Object.entries(canonicalHeaderValues).forEach(([headerKey, headerValue]) => {
                    if (!headerValue) return;
                    const idx = findHeaderIndexByKey(mapping.headers, headerKey);
                    if (idx < 0) {
                        addOrMergeHeader(mapping.headers, {
                            key: headerKey,
                            value: headerValue,
                            enabled: true,
                            description: '[XML] Valor mapeado automaticamente do log',
                            source: 'xml',
                            removable: true,
                            locked: false
                        });
                        return;
                    }
                    mapping.headers[idx].value = headerValue;
                    const tag = '[XML] Valor mapeado automaticamente do log';
                    const existingDesc = mapping.headers[idx].description || '';
                    if (!existingDesc.includes(tag)) {
                        mapping.headers[idx].description = existingDesc ? `${tag} ${existingDesc}` : tag;
                    }
                });

                // Body JSON
                if (['POST', 'PUT', 'PATCH'].includes(selectedOp.method) && op.requestBody) {
                    const jsonContent = op.requestBody.content?.['application/json'];
                    if (jsonContent) {
                        let bodyData = {};
                        let bodySchema = null;
                        
                        if (jsonContent.example) {
                            bodyData = typeof jsonContent.example === 'string' 
                                ? JSON.parse(jsonContent.example) 
                                : jsonContent.example;
                        } else if (jsonContent.schema) {
                            bodySchema = jsonContent.schema;
                            bodyData = generateExampleFromSchema(bodySchema, spec);
                        }

                        // Mapear valores do XML para campos do JSON usando a função robusta
                        if (xmlText && bodySchema) {
                            try {
                                // 1. Limpar o XML de caracteres inválidos (ex: backticks de markdown)
                                let cleanedXml = xmlText.replace(/`\s*/g, '').replace(/\s*`/g, '');

                                // 2. Extrair conteúdo da tag <message> se existir
                                // (aceita prefixo de namespace e atributos).
                                let contentToParse = cleanedXml;
                                const messageMatch = cleanedXml.match(/<(?:\w+:)?message\b[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/i);
                                if (messageMatch && messageMatch[1]) {
                                    contentToParse = messageMatch[1].trim();
                                }

                                // 3. Parse do XML completo (sem recortar apenas o Body),
                                // para preservar declarações de namespace do Envelope.
                                const xmlDoc = parseXmlSafely(contentToParse);
                                
                                // Select the best payload node based on schema
                                const resolvedBodySchema = resolveSchema(bodySchema, spec);
                                const bestContext = selectBestPayloadNode(xmlDoc, resolvedBodySchema || bodySchema);
                                
                                if (!bestContext) {
                                    throw new Error('Could not find suitable XML context node');
                                }
                                
                                // Map XML to JSON using the best context
                                const mappedData = mapBySchema(bodySchema, bestContext, spec);
                                
                                // Use mapped data if available, otherwise keep example
                                if (mappedData !== undefined) {
                                    bodyData = mappedData;
                                }
                            } catch (e) {
                                // Show user-friendly error and abort mapping
                                alert(`Erro ao mapear XML: ${e.message}`);
                                console.warn('Erro ao mapear XML:', e);
                                // Continue with example data instead of failing completely
                            }
                        }

                        const bodyFull = JSON.stringify(bodyData, null, 2);
                        const bodyPruned = (() => {
                            try {
                                const pruned = pruneEmptyFields(bodyData);
                                return pruned !== undefined ? JSON.stringify(pruned, null, 2) : '{}';
                            } catch (e) {
                                return bodyFull;
                            }
                        })();
                        
                        mapping.bodyFull = bodyFull;
                        mapping.bodyPruned = bodyPruned;
                        mapping.body = bodyFull; // Default to full
                    }
                }

                setMappingData(mapping);
                setShowMappingModal(true);
            };

            const handleGenerateCurl = () => {
                if (!selectedOp || !mappingData) return;

                let path = selectedOp.path;
                // Substituir path params
                mappingData.pathParams.forEach(p => {
                    if (p.enabled) {
                        path = path.replace(`{${p.key}}`, p.value);
                    }
                });

                // Query string
                const queryParams = mappingData.queryParams
                    .filter(p => p.enabled && p.value)
                    .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
                    .join('&');
                const fullPath = queryParams ? `${path}?${queryParams}` : path;

                // Headers
                const headers = mappingData.headers
                    .filter(h => h.enabled)
                    .map(h => `-H "${h.key}: ${h.value}"`)
                    .join(' \\\n    ');

                // Body
                let bodyPart = '';
                if (['POST', 'PUT', 'PATCH'].includes(selectedOp.method)) {
                    let bodyJson = '';
                    
                    // Use the correct body version based on prune mode
                    if (bodyOnlyWithValues && mappingData.bodyPruned) {
                        bodyJson = mappingData.bodyPruned;
                    } else if (mappingData.bodyFull) {
                        bodyJson = mappingData.bodyFull;
                    } else if (mappingData.body) {
                        bodyJson = mappingData.body;
                    }
                    
                    if (bodyJson) {
                        bodyPart = ` \\\n    --data-raw '${bodyJson.replace(/'/g, "'\\''")}'`;
                    }
                }

                const curl = `curl -X ${selectedOp.method} "{{ApigeeHost}}${fullPath}"${headers ? ' \\\n    ' + headers : ''}${bodyPart}`;
                const output = `# ${fullPath}\n${curl}`;
                setCurlOutput(output);
                setShowMappingModal(false);
            };

            const handleCopyCurl = () => {
                if (curlOutput) {
                    // Extrair o comando completo (removendo apenas a linha de comentário inicial)
                    const lines = curlOutput.split('\n');
                    const curlStartIndex = lines.findIndex(l => l.trim().startsWith('curl'));
                    const textToCopy = curlStartIndex !== -1 
                        ? lines.slice(curlStartIndex).join('\n') 
                        : curlOutput;

                    navigator.clipboard.writeText(textToCopy).then(() => {
                        alert('cURL copiado!');
                    });
                }
            };

            return (
                <div className="space-y-4">
                    {/* Folder Connection Header */}
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex items-center justify-between">
                        <div>
                            <h3 className="font-medium text-blue-900">Área de Trabalho</h3>
                            <p className="text-sm text-blue-700">
                                {dirHandle ? `Conectado: ${dirHandle.name}` : 'Nenhuma pasta conectada'}
                            </p>
                        </div>
                        <button
                            onClick={handleConnectFolder}
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
                        >
                            {dirHandle ? 'Alterar Pasta' : 'Selecionar Pasta de Trabalho'}
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2 flex justify-between items-center">
                                <span>OpenAPI Spec (YAML ou JSON)</span>
                                <span className="text-xs text-gray-500">
                                    {savedSpecs.length} guardadas localmente{dirHandle ? ` • ${availableSpecs.length} na pasta` : ''}
                                </span>
                            </label>
                            
                            {/* Available Specs List */}
                            {dirHandle && availableSpecs.length > 0 && (
                                <div className={`mb-2 border border-gray-200 rounded-md bg-gray-50 p-2 ${availableSpecs.length > 5 ? 'max-h-36 overflow-y-auto' : ''}`}>
                                    <p className="text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wider">Specs na pasta:</p>
                                    <div className="space-y-1">
                                        {availableSpecs.map((file, idx) => (
                                            <button
                                                key={idx}
                                                onClick={() => handleLoadFile(file, 'spec')}
                                                className="block w-full text-left text-xs px-2 py-1 hover:bg-white rounded border border-transparent hover:border-gray-200 truncate"
                                                title={file.name}
                                            >
                                                📄 {file.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Validated Specs from local history */}
                            {savedSpecs.length > 0 && (
                                <div className={`mb-2 border border-emerald-200 rounded-md bg-emerald-50 p-2 ${savedSpecs.length > 5 ? 'max-h-36 overflow-y-auto' : ''}`}>
                                    <p className="text-xs font-semibold text-emerald-700 mb-1 uppercase tracking-wider">Specs validadas (local):</p>
                                    <div className="space-y-1">
                                        {savedSpecs.map((item) => (
                                            <button
                                                key={item.id}
                                                onClick={() => setSpecText(item.content)}
                                                className="block w-full text-left text-xs px-2 py-1 hover:bg-white rounded border border-transparent hover:border-emerald-200 truncate"
                                                title={`${item.name} (${formatHistoryDate(item.createdAt)})`}
                                            >
                                                ✅ {item.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {highlightValidated ? (
                                <div className="relative w-full h-32 border border-gray-300 rounded-md overflow-hidden bg-white">
                                    <pre className="absolute inset-0 m-0 p-3 overflow-auto text-sm font-mono pointer-events-none opacity-0">
                                        <code ref={specHighlightRef} className={specHighlightLang}></code>
                                    </pre>
                                    <textarea
                                        ref={specTextareaRef}
                                        value={specText}
                                        onChange={(e) => setSpecText(e.target.value)}
                                        onFocus={() => setIsEditingSpec(true)}
                                        onScroll={() => syncOverlayScroll(specTextareaRef, specHighlightRef)}
                                        spellCheck={false}
                                        className="absolute inset-0 w-full h-full p-3 font-mono text-sm resize-none outline-none bg-white text-gray-900 caret-gray-900"
                                        placeholder="Cole a OpenAPI spec aqui ou selecione acima..."
                                    />
                                </div>
                            ) : (
                                <textarea
                                    value={specText}
                                    onChange={(e) => setSpecText(e.target.value)}
                                    className="w-full h-32 p-3 border border-gray-300 rounded-md font-mono text-sm"
                                    placeholder="Cole a OpenAPI spec aqui ou selecione acima..."
                                />
                            )}
                            <button
                                onClick={handleLoadSpec}
                                className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 w-full"
                            >
                                Validar & Carregar Spec
                            </button>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2 flex justify-between items-center">
                                <span>XML de Exemplo</span>
                                <span className="text-xs text-gray-500">
                                    {savedXmls.length} guardados localmente{dirHandle ? ` • ${availableXmls.length} na pasta` : ''}
                                </span>
                            </label>

                            {/* Available XMLs List */}
                            {dirHandle && availableXmls.length > 0 && (
                                <div className={`mb-2 border border-gray-200 rounded-md bg-gray-50 p-2 ${availableXmls.length > 5 ? 'max-h-36 overflow-y-auto' : ''}`}>
                                    <p className="text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wider">XMLs na pasta:</p>
                                    <div className="space-y-1">
                                        {availableXmls.map((file, idx) => (
                                            <button
                                                key={idx}
                                                onClick={() => handleLoadFile(file, 'xml')}
                                                className="block w-full text-left text-xs px-2 py-1 hover:bg-white rounded border border-transparent hover:border-gray-200 truncate"
                                                title={file.name}
                                            >
                                                📝 {file.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Validated XMLs from local history */}
                            {savedXmls.length > 0 && (
                                <div className={`mb-2 border border-emerald-200 rounded-md bg-emerald-50 p-2 ${savedXmls.length > 5 ? 'max-h-36 overflow-y-auto' : ''}`}>
                                    <p className="text-xs font-semibold text-emerald-700 mb-1 uppercase tracking-wider">XMLs validados (local):</p>
                                    <div className="space-y-1">
                                        {savedXmls.map((item) => (
                                            <button
                                                key={item.id}
                                                onClick={() => setXmlText(item.content)}
                                                className="block w-full text-left text-xs px-2 py-1 hover:bg-white rounded border border-transparent hover:border-emerald-200 truncate"
                                                title={`${item.name} (${formatHistoryDate(item.createdAt)})`}
                                            >
                                                ✅ {item.name}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {highlightValidated ? (
                                <div className="relative w-full h-32 border border-gray-300 rounded-md overflow-hidden bg-white">
                                    <pre className="absolute inset-0 m-0 p-3 overflow-auto text-sm font-mono pointer-events-none opacity-0">
                                        <code ref={xmlHighlightRef} className="xml"></code>
                                    </pre>
                                    <textarea
                                        ref={xmlTextareaRef}
                                        value={xmlText}
                                        onChange={(e) => setXmlText(e.target.value)}
                                        onFocus={() => setIsEditingXml(true)}
                                        onScroll={() => syncOverlayScroll(xmlTextareaRef, xmlHighlightRef)}
                                        spellCheck={false}
                                        className="absolute inset-0 w-full h-full p-3 font-mono text-sm resize-none outline-none bg-white text-gray-900 caret-gray-900"
                                        placeholder="Cole XML de exemplo aqui ou selecione acima..."
                                    />
                                </div>
                            ) : (
                                <textarea
                                    value={xmlText}
                                    onChange={(e) => setXmlText(e.target.value)}
                                    className="w-full h-32 p-3 border border-gray-300 rounded-md font-mono text-sm"
                                    placeholder="Cole XML de exemplo aqui ou selecione acima..."
                                />
                            )}
                        </div>
                    </div>

                    {operations.length > 0 && (
                        <>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Confirme a operação REST
                                </label>

                                {autoSuggestion && (
                                    <div className={`mb-4 rounded-lg border p-4 ${
                                        autoSuggestion.type === 'success'
                                            ? 'bg-emerald-50 border-emerald-200'
                                            : 'bg-amber-50 border-amber-200'
                                    }`}>
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">{autoSuggestion.title || 'Operação sugerida'}</p>
                                                <p className="text-sm text-gray-800 font-mono mt-1 break-all">{autoSuggestion.message}</p>
                                            </div>
                                            <span className="text-[11px] px-2 py-1 rounded-full bg-gray-900 text-white">AI Match Engine v2</span>
                                        </div>

                                        <div className="mt-3">
                                            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                                                <span>Confiança</span>
                                                <span>{autoSuggestion.confidence || 0}%</span>
                                            </div>
                                            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full ${getConfidenceTone(autoSuggestion.confidence || 0)}`}
                                                    style={{ width: `${Math.max(0, Math.min(100, autoSuggestion.confidence || 0))}%` }}
                                                />
                                            </div>
                                            <p className="mt-1 text-[11px] text-gray-500">
                                                Score baseado em namespace + targetPath + payload + versão.
                                            </p>
                                        </div>

                                        {Array.isArray(autoSuggestion.reasons) && autoSuggestion.reasons.length > 0 && (
                                            <div className="mt-3">
                                                <p className="text-xs font-semibold text-gray-700 mb-1">Motivos principais</p>
                                                <ul className="text-xs text-gray-700 space-y-1">
                                                    {autoSuggestion.reasons.map((reason, idx) => (
                                                        <li key={idx}>• {reason}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        {(autoSuggestion.confidence || 0) < 80 && (
                                            <div className="mt-3 px-3 py-2 rounded-md bg-amber-100 text-amber-900 text-xs border border-amber-300">
                                                Correspondência parcial. Existem várias operações possíveis, reveja antes de aplicar.
                                            </div>
                                        )}

                                        <div className="mt-3 flex flex-wrap gap-2">
                                            <button
                                                onClick={handlePrepareMapping}
                                                className="px-3 py-2 bg-purple-700 text-white rounded-md hover:bg-purple-800 text-sm font-medium"
                                            >
                                                Aplicar mapeamento
                                            </button>
                                            <button
                                                onClick={() => setAnalysisExpanded((prev) => !prev)}
                                                className="px-3 py-2 border border-gray-300 bg-white rounded-md hover:bg-gray-50 text-sm"
                                            >
                                                Como esta operação foi escolhida
                                            </button>
                                        </div>

                                        {analysisExpanded && autoSuggestion.details && (
                                            <div className="mt-3 rounded-md border border-gray-200 bg-white">
                                                <div className="flex flex-wrap gap-1 p-2 border-b border-gray-200">
                                                    {[
                                                        { id: 'signals', label: 'Signals' },
                                                        { id: 'ranking', label: 'Ranking' },
                                                        { id: 'alternatives', label: 'Alternativas' },
                                                        { id: 'raw', label: 'Raw output' }
                                                    ].map((tab) => (
                                                        <button
                                                            key={tab.id}
                                                            onClick={() => setAnalysisTab(tab.id)}
                                                            className={`px-2 py-1 text-xs rounded-md ${
                                                                analysisTab === tab.id
                                                                    ? 'bg-blue-600 text-white'
                                                                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                                                            }`}
                                                        >
                                                            {tab.label}
                                                        </button>
                                                    ))}
                                                </div>

                                                <div className="p-3 text-xs text-gray-700">
                                                    {analysisTab === 'signals' && (
                                                        <pre className="max-h-56 overflow-auto bg-gray-50 border border-gray-200 rounded p-2 text-[11px]">
{JSON.stringify(autoSuggestion.details.signalsExtracted || {}, null, 2)}
                                                        </pre>
                                                    )}
                                                    {analysisTab === 'ranking' && (
                                                        <div className="space-y-2 max-h-56 overflow-auto">
                                                            {(autoSuggestion.details.ranking || []).map((item, idx) => (
                                                                <div key={`${item.method}-${item.path}-${idx}`} className="border border-gray-200 rounded p-2">
                                                                    <div className="flex items-center justify-between gap-2">
                                                                        <span className="font-mono text-[11px] break-all">{item.method} {item.path}</span>
                                                                        <span className="text-[11px] font-semibold">{item.confidence}%</span>
                                                                    </div>
                                                                    <div className="mt-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                                                        <div className={`h-full ${getConfidenceTone(item.confidence || 0)}`} style={{ width: `${item.confidence || 0}%` }} />
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {analysisTab === 'alternatives' && (
                                                        <div className="max-h-64 overflow-auto border border-gray-200 rounded">
                                                            <table className="min-w-full divide-y divide-gray-200">
                                                                <thead className="bg-gray-50">
                                                                    <tr>
                                                                        <th className="px-2 py-1 text-left font-semibold">Endpoint</th>
                                                                        <th className="px-2 py-1 text-left font-semibold">Score</th>
                                                                        <th className="px-2 py-1 text-left font-semibold">Namespace</th>
                                                                        <th className="px-2 py-1 text-left font-semibold">Payload</th>
                                                                        <th className="px-2 py-1 text-left font-semibold">Versão</th>
                                                                        <th className="px-2 py-1 text-left font-semibold">Status</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-gray-100 bg-white">
                                                                    {(autoSuggestion.details.ranking || []).map((item, idx) => (
                                                                        <tr key={`${item.method}-${item.path}-${idx}`}>
                                                                            <td className="px-2 py-1 font-mono text-[11px] break-all">{item.path}</td>
                                                                            <td className="px-2 py-1">
                                                                                <div className="flex items-center gap-2">
                                                                                    <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                                                                        <div className={`h-full ${getConfidenceTone(item.confidence || 0)}`} style={{ width: `${item.confidence || 0}%` }} />
                                                                                    </div>
                                                                                    <span className="text-[11px]">{item.confidence}%</span>
                                                                                </div>
                                                                            </td>
                                                                            <td className="px-2 py-1">{item.namespace ? 'OK' : '-'}</td>
                                                                            <td className="px-2 py-1">{item.payload ? 'OK' : '-'}</td>
                                                                            <td className="px-2 py-1">{item.version || '-'}</td>
                                                                            <td className="px-2 py-1">{item.status || '-'}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    )}
                                                    {analysisTab === 'raw' && (
                                                        <pre className="max-h-56 overflow-auto bg-gray-50 border border-gray-200 rounded p-2 text-[11px]">
{JSON.stringify(autoSuggestion.details.rawOutput || autoSuggestion.details || {}, null, 2)}
                                                        </pre>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                                    <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">All Operations</p>
                                    {autoFiltersEnabled && getAppliedFilterChips().length > 0 && (
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <span className="text-xs text-gray-500">Filtros aplicados:</span>
                                            {getAppliedFilterChips().map((chip) => (
                                                <span key={chip.key} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-100 text-blue-800 text-xs">
                                                    {chip.label}
                                                    <button
                                                        onClick={() => dismissSuggestionFilter(chip.key)}
                                                        className="text-blue-700 hover:text-blue-900"
                                                        aria-label={`Remover filtro ${chip.label}`}
                                                    >
                                                        x
                                                    </button>
                                                </span>
                                            ))}
                                            <button
                                                onClick={() => dismissSuggestionFilter('all')}
                                                className="text-xs text-gray-600 underline"
                                            >
                                                limpar todos
                                            </button>
                                        </div>
                                    )}

                                    <label className="flex items-center gap-2 mb-2 text-sm text-gray-700">
                                        <input
                                            type="checkbox"
                                            checked={hideDeprecated}
                                            onChange={(e) => setHideDeprecated(e.target.checked)}
                                        />
                                        <span>Ocultar operações deprecated</span>
                                    </label>

                                    <input
                                        type="text"
                                        value={opSearchTerm}
                                        onChange={(e) => setOpSearchTerm(e.target.value)}
                                        placeholder="Filtrar por método, path ou versão..."
                                        className="w-full mb-2 px-3 py-2 border border-gray-300 rounded-md text-sm"
                                    />

                                    <div className="border border-gray-300 rounded-md overflow-hidden bg-white">
                                        <div className="max-h-60 overflow-y-auto">
                                            <table className="min-w-full divide-y divide-gray-200">
                                                <thead className="bg-gray-50 sticky top-0">
                                                    <tr>
                                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Método</th>
                                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Versão</th>
                                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Endpoint</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-gray-200">
                                                    {operations
                                                        .filter(op => {
                                                            const term = opSearchTerm.toLowerCase();
                                                            const matchesSearch = op.method.toLowerCase().includes(term) ||
                                                                   op.path.toLowerCase().includes(term) ||
                                                                   extractVersion(op.path).toLowerCase().includes(term);
                                                            const passesDeprecatedFilter = !hideDeprecated || !op.operation.deprecated;
                                                            return matchesSearch && passesDeprecatedFilter && filterOperationWithSuggestion(op);
                                                        })
                                                        .map((op, idx) => {
                                                            const isSelected = selectedOp && selectedOp.method === op.method && selectedOp.path === op.path;
                                                            const version = extractVersion(op.path);

                                                            return (
                                                                <tr
                                                                    key={idx}
                                                                    onClick={() => setSelectedOp(op)}
                                                                    className={`cursor-pointer hover:bg-blue-50 ${isSelected ? 'bg-blue-100 ring-1 ring-inset ring-blue-300' : ''}`}
                                                                >
                                                                    <td className="px-4 py-2 whitespace-nowrap">
                                                                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getMethodPillClass(op.method)}`}>
                                                                            {op.method}
                                                                        </span>
                                                                    </td>
                                                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500">
                                                                        {version}
                                                                    </td>
                                                                    <td className="px-4 py-2 text-sm text-gray-900 break-all">
                                                                        {op.path}
                                                                        {op.operation.deprecated && (
                                                                            <span className="ml-2 text-xs text-yellow-600 bg-yellow-50 px-1 rounded border border-yellow-200">
                                                                                Deprecated
                                                                            </span>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="sticky bottom-0 z-10 bg-white/95 backdrop-blur border border-gray-200 rounded-md p-3 flex flex-col gap-3">
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={includeEmptyFields}
                                        onChange={(e) => setIncludeEmptyFields(e.target.checked)}
                                    />
                                    <span className="text-sm">Incluir campos em falta com "" no JSON</span>
                                </label>

                                <button
                                    onClick={handlePrepareMapping}
                                    className="w-full px-4 py-3 bg-purple-700 text-white rounded-md hover:bg-purple-800 font-semibold"
                                >
                                    Confirmar operação e mapear
                                </button>
                            </div>
                        </>
                    )}

                    {showMappingModal && mappingData && (
                        <MappingModal
                            mappingData={mappingData}
                            setMappingData={setMappingData}
                            xmlText={xmlText}
                            includeEmptyFields={includeEmptyFields}
                            bodyOnlyWithValues={bodyOnlyWithValues}
                            setBodyOnlyWithValues={setBodyOnlyWithValues}
                            onGenerate={handleGenerateCurl}
                            onCancel={() => setShowMappingModal(false)}
                        />
                    )}

                    {curlOutput && (
                        <div className="space-y-2">
                            <label className="block text-sm font-medium text-gray-700">
                                cURL gerado
                            </label>
                            <textarea
                                readOnly
                                value={curlOutput}
                                className="w-full h-48 p-3 border border-gray-300 rounded-md font-mono text-xs bg-gray-50"
                            />
                            <button
                                onClick={handleCopyCurl}
                                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                            >
                                📋 Copiar cURL
                            </button>
                        </div>
                    )}
                </div>
            );
        }

        // Modal de mapeamento
        function MappingModal({ mappingData, setMappingData, xmlText, includeEmptyFields, bodyOnlyWithValues, setBodyOnlyWithValues, onGenerate, onCancel }) {
            const [showBody, setShowBody] = useState(true);
            const [showCollapsedXmlHeaders, setShowCollapsedXmlHeaders] = useState(false);
            const codeBlockRef = useRef(null);
            const bodyCodeRef = useRef(null);

            useEffect(() => {
                if (codeBlockRef.current) {
                    hljs.highlightElement(codeBlockRef.current);
                }
            }, [xmlText]);

            // Get current body to display based on prune mode
            const getCurrentBody = () => {
                if (bodyOnlyWithValues && mappingData.bodyPruned) {
                    return mappingData.bodyPruned;
                }
                return mappingData.bodyFull || mappingData.body || '';
            };
            const currentBody = getCurrentBody();

            useEffect(() => {
                if (bodyCodeRef.current) {
                    bodyCodeRef.current.textContent = currentBody;
                    hljs.highlightElement(bodyCodeRef.current);
                }
            }, [currentBody]);

            const updateMapping = (type, index, field, value) => {
                const newData = { ...mappingData };
                newData[type][index][field] = value;
                setMappingData(newData);
            };

            const removeMappingItem = (type, index) => {
                const newData = { ...mappingData };
                newData[type] = (newData[type] || []).filter((_, idx) => idx !== index);
                setMappingData(newData);
            };

            const addManualHeader = () => {
                const newData = { ...mappingData };
                if (!Array.isArray(newData.headers)) newData.headers = [];
                newData.headers.push({
                    key: '',
                    value: '',
                    enabled: true,
                    description: '[MANUAL] Header adicionado manualmente',
                    source: 'manual',
                    removable: true,
                    locked: false
                });
                setMappingData(newData);
            };

            const updateBody = (value) => {
                const newData = { ...mappingData };
                if (bodyOnlyWithValues) {
                    // Update pruned version
                    newData.bodyPruned = value;
                    // Recompute full from pruned if needed (or keep existing full)
                    if (!newData.bodyFull) {
                        newData.bodyFull = value;
                    }
                } else {
                    // Update full version
                    newData.bodyFull = value;
                    // Recompute pruned
                    try {
                        const parsed = JSON.parse(value);
                        const pruned = pruneEmptyFields(parsed);
                        newData.bodyPruned = pruned !== undefined ? JSON.stringify(pruned, null, 2) : '{}';
                    } catch (e) {
                        newData.bodyPruned = value;
                    }
                }
                newData.body = bodyOnlyWithValues ? newData.bodyPruned : newData.bodyFull;
                setMappingData(newData);
            };

            const handleTogglePrune = (enabled) => {
                setBodyOnlyWithValues(enabled);
                // Update displayed body immediately
                const newData = { ...mappingData };
                newData.body = enabled ? (newData.bodyPruned || newData.body) : (newData.bodyFull || newData.body);
                setMappingData(newData);
            };

            const getHeaderPriority = (header) => {
                if (header.source === 'yaml-required') return 0;
                if (header.source === 'default') return 1;
                if (header.source === 'spec') return 2;
                if (header.source === 'manual') return 3;
                if (header.source === 'xml') return 4;
                return 5;
            };

            const headerEntries = (mappingData.headers || [])
                .map((header, index) => ({ header, index }))
                .sort((a, b) => {
                    const p = getHeaderPriority(a.header) - getHeaderPriority(b.header);
                    if (p !== 0) return p;
                    return String(a.header.key || '').localeCompare(String(b.header.key || ''));
                });
            const collapsedXmlHeaderEntries = headerEntries.filter(({ header }) => header.source === 'xml' && !header.enabled);
            const visibleHeaderEntries = headerEntries.filter(({ header }) => !(header.source === 'xml' && !header.enabled));

            const renderHeaderRow = ({ header, index }) => (
                <div
                    key={`header-${index}`}
                    className={`rounded-md p-1.5 ${
                        (header.source === 'default' || header.source === 'yaml-required')
                            ? 'bg-indigo-50 border border-indigo-200'
                            : 'bg-transparent'
                    }`}
                >
                    <div className="flex gap-2 items-center mb-1">
                        <input
                            type="checkbox"
                            checked={header.enabled}
                            onChange={(e) => updateMapping('headers', index, 'enabled', e.target.checked)}
                        />
                        <input
                            type="text"
                            value={header.key}
                            onChange={(e) => updateMapping('headers', index, 'key', e.target.value)}
                            readOnly={header.locked}
                            className={`w-44 px-2 py-1 border border-gray-300 rounded text-sm font-mono ${header.locked ? 'bg-gray-50 text-gray-700' : 'bg-white'}`}
                            placeholder="Header-Name"
                        />
                        <input
                            type="text"
                            value={header.value}
                            onChange={(e) => updateMapping('headers', index, 'value', e.target.value)}
                            className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                        />
                        {header.removable !== false && (
                            <button
                                type="button"
                                onClick={() => removeMappingItem('headers', index)}
                                className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                            >
                                Remover
                            </button>
                        )}
                    </div>
                    {(header.source === 'default' || header.source === 'yaml-required') && (
                        <p className="text-[11px] text-indigo-700 ml-8 font-medium">
                            {header.source === 'yaml-required' ? '[YAML OBRIGATÓRIO]' : '[DEFAULT]'}
                        </p>
                    )}
                    {header.description && (
                        <p className="text-xs text-gray-600 ml-8">{header.description}</p>
                    )}
                </div>
            );

            return (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-y-auto">
                        <div className="p-6">
                            <h2 className="text-xl font-bold mb-4">Mapeamento XML → JSON</h2>
                            
                            <div className="grid grid-cols-2 gap-4 items-stretch">
                                <div className="h-full flex flex-col">
                                    <label className="block text-sm font-medium text-gray-700 mb-2">XML (read-only)</label>
                                    <pre className="w-full flex-1 p-3 border border-gray-300 rounded-md font-mono text-xs bg-gray-800 text-white overflow-visible whitespace-pre-wrap break-words"><code ref={codeBlockRef} className="xml">{xmlText}</code></pre>
                                </div>

                                <div className="space-y-4 h-full">
                                    {/* Path Params */}
                                    {mappingData.pathParams.length > 0 && (
                                        <div>
                                            <h3 className="font-semibold mb-2">Path Params</h3>
                                            <div className="space-y-2">
                                                {mappingData.pathParams.map((param, idx) => (
                                                    <div key={idx} className="flex gap-2 items-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={param.enabled}
                                                            onChange={(e) => updateMapping('pathParams', idx, 'enabled', e.target.checked)}
                                                        />
                                                        <span className="w-24 text-sm font-mono">{param.key}:</span>
                                                        <input
                                                            type="text"
                                                            value={param.value}
                                                            onChange={(e) => updateMapping('pathParams', idx, 'value', e.target.value)}
                                                            className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Query Params */}
                                    {mappingData.queryParams.length > 0 && (
                                        <div>
                                            <h3 className="font-semibold mb-2">Query Params</h3>
                                            <div className="space-y-2">
                                                {mappingData.queryParams.map((param, idx) => (
                                                    <div key={idx} className="flex gap-2 items-center">
                                                        <input
                                                            type="checkbox"
                                                            checked={param.enabled}
                                                            onChange={(e) => updateMapping('queryParams', idx, 'enabled', e.target.checked)}
                                                        />
                                                        <span className="w-24 text-sm font-mono">{param.key}:</span>
                                                        <input
                                                            type="text"
                                                            value={param.value}
                                                            onChange={(e) => updateMapping('queryParams', idx, 'value', e.target.value)}
                                                            className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Headers */}
                                    {mappingData.headers.length > 0 && (
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <h3 className="font-semibold">Headers</h3>
                                                <button
                                                    type="button"
                                                    onClick={addManualHeader}
                                                    className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                                                >
                                                    + Adicionar header
                                                </button>
                                            </div>
                                            <div className="space-y-2">
                                                {visibleHeaderEntries.map(renderHeaderRow)}

                                                {collapsedXmlHeaderEntries.length > 0 && (
                                                    <div className="border border-gray-200 rounded-md">
                                                        <button
                                                            type="button"
                                                            onClick={() => setShowCollapsedXmlHeaders((prev) => !prev)}
                                                            className="w-full px-3 py-2 text-left text-xs font-medium bg-gray-50 hover:bg-gray-100 rounded-md"
                                                        >
                                                            {showCollapsedXmlHeaders ? 'Ocultar' : 'Mostrar'} headers do log não ativos ({collapsedXmlHeaderEntries.length})
                                                        </button>
                                                        {showCollapsedXmlHeaders && (
                                                            <div className="p-2 space-y-2">
                                                                {collapsedXmlHeaderEntries.map(renderHeaderRow)}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Body JSON */}
                                    {mappingData.body && (
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <h3 className="font-semibold">Body JSON</h3>
                                                <div className="flex gap-4">
                                                    <label className="flex items-center gap-1 text-sm">
                                                        <input
                                                            type="checkbox"
                                                            checked={showBody}
                                                            onChange={(e) => setShowBody(e.target.checked)}
                                                        />
                                                        <span>Mostrar body</span>
                                                    </label>
                                                    <label className="flex items-center gap-1 text-sm">
                                                        <input
                                                            type="checkbox"
                                                            checked={bodyOnlyWithValues}
                                                            onChange={(e) => handleTogglePrune(e.target.checked)}
                                                        />
                                                        <span>Campos com valores</span>
                                                    </label>
                                                </div>
                                            </div>
                                            {showBody && (
                                    <pre className="w-full p-3 border border-gray-300 rounded-md font-mono text-xs bg-gray-800 text-white overflow-visible whitespace-pre-wrap break-words">
                                        <code 
                                            ref={bodyCodeRef}
                                            contentEditable="true"
                                            onBlur={e => updateBody(e.currentTarget.textContent)}
                                            className="json"
                                        >
                                        </code>
                                    </pre>
                                )}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="flex gap-2 mt-6">
                                <button
                                    onClick={onCancel}
                                    className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={onGenerate}
                                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                                >
                                    Gerar cURL
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }
export default App;

