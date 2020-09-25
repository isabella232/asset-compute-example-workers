/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
'use strict';

const { worker, SourceCorruptError } = require('@adobe/asset-compute-sdk');
const { serializeXmp } = require("@adobe/asset-compute-xmp");
const axios = require('axios');

const path = require('path');
const { createReadStream } = require('fs');
const fs = require('fs').promises;
const FormData = require('form-data');

const DEFAULT_ANALYZER_ID = "Feature:cintel-ner:Service-7a87cb57461345c280b62470920bcdc5";
const DEFAULT_CCAI_ENDPOINT = "https://sensei.adobe.io/services/v1/predict";
const CONTENT_ID = 'abc123';

/**
 * Parse raw response from CCAI api and return just the relevant `response` section
 * 
 * @param {*} response JSON response from Content and Commerce AI service
 * @returns {Array} Array of feature values and names from the service
 */
function parseResponse(response) {
    for (const cas of response.cas_responses) {
        if (cas.status === 200 && cas.result.response_type === "feature") {
            return cas.result.response;
        }
    }
}


/**
 * @typedef {Object} Entity
 * @property {String} name entity name
 * @property {String} type entity type from list of recognized entities
 * @property {Number} score confidence score (0.0-1.0)
 */
/**
 * Parse keywords in feature response
 * 
 * @param {*} response JSON response from Content and Commerce AI service
 * @returns {Entity[]} Color features returned by the service
 */
function parseEntities(response) {
    const entities = [];
    const resp = parseResponse(response);
    for (const features of resp) {
        if (features.feature_name === CONTENT_ID) {
            for (const feature of features.feature_value) {
                if (feature.feature_name === "labels") {
                    const labels = feature.feature_value // array of feature values and names of labels
                    for (const label of labels) {
                        const valuesObj = {};
                        label.feature_value.forEach(f => {
                            valuesObj[f.feature_name] = f.feature_value;
                        });
                        entities.push(Object.assign({
                            name: label.feature_name,
                        }, valuesObj));
                    }
                }
            }
        }
    }
    return entities;
}

exports.main = worker(async (source, rendition, params) => {
    // Acquire end point and analyzer
    const analyzer_id = rendition.instructions.ANALYZER_ID || DEFAULT_ANALYZER_ID;
    const endpoint = rendition.instructions.CCAI_ENDPOINT || DEFAULT_CCAI_ENDPOINT;
    console.log("Using analyzer:", analyzer_id);
    console.log("Using endpoint:", endpoint);

    // Make sure that the source file is not empty
    const stats = await fs.stat(source.path);
    if (stats.size === 0) {
        throw new SourceCorruptError('source file is empty');
    }

    // Build parameters to send to Sensei service
    const ext = path.extname(source.path);
    const parameters = {
        "application-id": "1234",                             
        "content-type": "file",                                         
        "encoding": "pdf",                                   
        "data": [                                
          {                                   
            "content-id": CONTENT_ID,                 
            "content": "file"         
          }                  
        ]
    };

    // Build form to post
    const formData = new FormData();
    formData.append('file', createReadStream(source.path));
    formData.append('contentAnalyzerRequests', JSON.stringify({
        enable_diagnostics: true,
        requests: [{
            analyzer_id,
            parameters,
            "content_id": "test123",
        }]
    }));

    // Authorization
    let accessToken = params.auth && params.auth.accessToken;
    let clientId = params.auth && params.auth.clientId;
    if (process.env.WORKER_TEST_MODE) {
        accessToken = "test-access-token";
        clientId = "test-client-id";
    }

    // Execute request
    const response = await axios.post(
        endpoint,
        formData,
        {
            headers: Object.assign({
                'Authorization': 'Bearer ' + accessToken,
                'cache-control': 'no-cache,no-cache',
                'Content-Type': 'multipart/form-data',
                'x-api-key': clientId,
            }, formData.getHeaders())
        }
    );
    const entities = parseEntities(response.data);
    console.log('###### ENTITIES', entities);

    // Parse, sort, serialize to XMP
    const xmp = serializeXmp({
        "ccai:entityName": entities.map(entity => `${entity.type}, ${entity.name}, ${entity.score}`),
        "ccai:entity": entities.map(entity => ({
            "ccai:name": entity.name,
            "ccai:type": entity.type,
            "ccai:score": entity.score
        }))
    }, {
        namespaces: {
            ccai: "https://example.com/schema/ccai"
        }
    });

    // Write XMP metadata as output
    await fs.writeFile(rendition.path, xmp);
});
