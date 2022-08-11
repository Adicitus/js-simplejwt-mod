"strict"
const jwt = require('jsonwebtoken')
const {v4: uuidv4} = require('uuid')
const Crypto = require('crypto')
const { DateTime, Duration } = require('luxon')

/**
 * Class to facilitate the creation and verification JSON Web Tokens using public key cryptography.
 * 
 * Tokens generated by this class enforce the inclusion and verification of subjext ("sub"), issuer ("iss") and key id ("kid") fields.
 */
class JWTGenerator {

    /**
     * Key length to use when generating new key pairs.
     */
    keyLength = 1024
    /**
     * Signing algorithm used when generating the tokens.
     * 
     * For a list of supported algorithms see: [https://github.com/auth0/node-jws#jwsalgorithms](https://github.com/auth0/node-jws#jwsalgorithms).
     */
    algorithm = 'ES256'
    /**
     * Luxon Duration object representing the default lifetime of tokens generated.
     */
    tokenLifetime = null

    /**
     * ID of this generator. This value will be included as the issuer of any tokens generated.
     */
    id = null
    /**
     * The current public key used when generating tokens.
     */
    #publicKey = null
    /**
     * The current private key used when generating tokens.
     */
    #privateKey = null
    /**
     * Interval object used to continuously update key pair.
     */
    #keyUpdateInterval = null
    /**
     * MongoDB collection used to store token verification records.
     */
    #tokenCollection = null

    /**
     * Create a new token generator.
     * 
     * @param {object} options - Additional options to customize the generator.
     *  - **id**: Manually assigned id for this generator, this value will be included as the issuer ("iss") of any tokens generated. If not specified, a UUID will be generated.
     *  - **collection**: MongoDB collection to record tokens in. If this is not provided then records must be stored and retrieved manualy.'
     *  - **keyLifetime**: How often the keys should be regenerated (luxon duration object). Setting this to 0 or less will cause the keys to be regenerated after each new token.
     *  - **tokenLifetime**: How long the tokens should remain valid by default (luxon duration object).
     */
    constructor(options) {
        this.id = uuidv4()

        this.tokenLifetime = Duration.fromObject({ minutes: 30  })
        let keyLifetime = Duration.fromObject({minutes: 60})
        
        if (options) {
            if (options.id) {
                this.id = options.id
            }
            if (options.collection) {
                this.tokenCollection = options.collection
            }
            if (options.keyLifetime !== undefined) {
                if (options.keyLifetime.isLuxonDuration) {
                    keyLifetime = new Duration(options.keyLifetime)
                } else {
                    keyLifetime = Duration.fromObject(options.keyLifetime)
                }
            }
            if (options.tokenLifetime) {
                if (options.tokenLifetime.isLuxonDuration) {
                    this.tokenLifetime = new Duration(options.tokenLifetime)
                } else {
                    this.tokenLifetime = Duration.fromObject(options.tokenLifetime)
                }
            }
        }
        
        this.generateKeys()
        if (keyLifetime.toMillis() > 0) {
            this.keyUpdateInterval = setInterval(() => this.generateKeys(), keyLifetime.toMillis())
        }
    }

    /**
     * Regenerates the DSA key pair used to generate tokens.
     */
    generateKeys() {
        let keyPair = Crypto.generateKeyPairSync('dsa', { modulusLength: this.keyLength })
        this.publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' })
        this.privateKey = keyPair.privateKey.export({ type: 'pkcs8', format:'pem' })
    }

    /**
     * Used to generate a token for the provided subject.
     * 
     * @param {object} subject - Subject authenticated by this token.
     * @param {object} options - Additional options.
     *  - **duration**: A luxon duration to to define how long the token should be valid.
     *              This can be used to override the default set when the instance is created, but should otherwise not be used.
     *  - **payload**: An object with fields/values that should included in the payload, this can be used to include additional custom claims.
     *              This cannot be used to overwrite the subject ("sub"), issuer ("iss"), issued at ("iat") or expires ("exp") fields.
     * @returns {object} Object containing 2 properties: "record" and "token".
     *  - **record**: An object containing information necessary to verify the validity of the token, and should be stored by the server.
     *      - If the generator has been set up with a MongoDB collection, then the record will automatically be stored there.
     *  - **token**: A string representation of the token, this should be passed to the client. 
     */
    async newToken(subject, options) {

        let now = DateTime.now()

        let duration = this.tokenLifetime

        
        var payload = {
            sub: subject,
            iss: this.id
        }

        if (options) {
            if (options.duration) {
                if (options.duration.isLuxonDuration) {
                    duration = new Duration(options.duration)
                } else {
                    duration = Duration.fromObject(options.duration)
                }
            }
            if(options.payload) {
                for (const claim in options.payload) {
                    if ((null == payload[claim])) {
                        payload[claim] = options.payload[claim]
                    }
                }
            }
        }

        let validTo = now.plus(duration)

        var tokenRecord = {
            id: uuidv4(),
            subject: subject,
            issuer: this.id,
            key: this.publicKey,
            issued: now,
            expires: validTo
        }

        var token = jwt.sign(payload, this.privateKey, {algorithm: this.algorithm, expiresIn: `${duration.as('hour')}h`, keyid: tokenRecord.id})

        if (this.tokenCollection) {
            var currentTokenRecord = await this.tokenCollection.findOne({subject: subject})

            if (currentTokenRecord) {
                this.tokenCollection.replaceOne({id: currentTokenRecord.id}, tokenRecord)
            } else {
                this.tokenCollection.insertOne(tokenRecord)
            }
        }
        
        if (!this.keyUpdateInterval) {
            this.generateKeys()
        }

        return { record: tokenRecord, token: token }
    }

    /**
     * Attempts to validate the provided token.
     * 
     * Returns an object with the subject of the token if successful.
     * 
     * Otherwise returns an object with an error status and reason.
     * 
     * @param {string} token - Token to validate.
     * @param {object} options - Additional options.
     *  - **record**: A token record object used to verify the token. Used to debug the generator without a MongoDB collection.
     * @returns {object} An object describing the state of the verification, it may contain the following fields:
     *  - **success**: A boolean describing whether the token was successfully verified.
     *  - **subject**: If the token was verified successfully, this field will indicate the identity of the client.
     *      - This is the same value as the one in the payload.
     *  - **payload**: If the token was verified successfully, The full payload field from the token.
     *  - **status**: If the verification failed, this short string indicates what caused the failure.
     *      - noRecordError: No record source available or couldn't find a matching record.
     *      - invalidRecordError: A record was found but is missing the Key ID, Issuer or Subject values.
     *      - invalidTokenError: The token could not be verified using the key on record or has expired.
     *  - **reason**: If the verification failed, this property may be included to provide a more user-friendly description of what caused the verification to fail.
     */
    async verifyToken(token, options) {
        try {
            let {header, payload} = jwt.decode(token, {complete: true})
            let tokenRecord = null

            if (options && options.record) {
                tokenRecord = options.record
            } else if (this.tokenCollection) {
                tokenRecord = await this.tokenCollection.findOne({id: header.kid})
            } else {
                return { success: false, status: 'noRecordError', reason: 'No record source available.' }
            }

            if (!tokenRecord) {
                return { success: false, status: 'noRecordError', reason: `No record found for the token (ID: '${header.kid}').` }
            }

            if (!(tokenRecord.key && tokenRecord.issuer && tokenRecord.subject)) {
                return { success: false, status: 'invalidRecordError', reason: `Token record is incomplete (ID: '${header.kid}').` }
            }

            jwt.verify(token, tokenRecord.key, {issuer: tokenRecord.issuer, subject: tokenRecord.subject})

            let r = { success: true, subject: tokenRecord.subject, payload: payload }

            return r

        } catch {
            return { success: false, status: 'invalidTokenError', reason: 'Token does not match key on record or is expired.' }
        }
    }

    /**
     * Stops the regular regeneration of the key pair (if applicable).
     */
    async dispose() {
        clearInterval(this.keyUpdateInterval)
        this.keyUpdateInterval = null
    }

}

module.exports = JWTGenerator