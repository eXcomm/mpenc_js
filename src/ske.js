/**
 * @fileOverview
 * Implementation of an authenticated Signature Key Exchange scheme.
 */

(function() {
    "use strict";

    /**
     * @namespace
     * Implementation of an authenticated Signature Key Exchange scheme.
     * 
     * @description
     * <p>Implementation of an authenticated Signature Key Exchange scheme.</p>
     * 
     * <p>
     * This scheme is trying to prevent replay attacks by the use of a nonce-based
     * session ID as described in </p>
     * 
     * <p>
     * Jens-Matthias Bohli and Rainer Steinwandt. 2006.<br/>
     * "Deniable Group Key Agreement."<br/>
     * VIETCRYPT 2006, LNCS 4341, pp. 298-311.</p>
     * 
     * <p>
     * This implementation is using the Edwards25519 for an ECDSA signature
     * mechanism to complement the Curve25519-based group key agreement.</p>
     */
    mpenc.ske = {};

    var _assert = mpenc.assert.assert;

    /*
     * Created: 5 Feb 2014 Guy K. Kloss <gk@mega.co.nz>
     *
     * (c) 2014 by Mega Limited, Wellsford, New Zealand
     *     http://mega.co.nz/
     *
     * This file is part of the multi-party chat encryption suite.
     *
     * This code is free software: you can redistribute it and/or modify
     * it under the terms of the GNU Affero General Public License version 3
     * as published by the Free Software Foundation. See the accompanying
     * LICENSE file or <https://www.gnu.org/licenses/> if it is unavailable.
     * 
     * This code is distributed in the hope that it will be useful,
     * but WITHOUT ANY WARRANTY; without even the implied warranty of
     * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
     */
    
    /**
     * Carries message content for the authenticated signature key exchange.
     * 
     * @constructor
     * @param source
     *     Message originator (from).
     * @param dest
     *     Message destination (to).
     * @param flow
     *     Message type.
     * @param members
     *     List (array) of all participating members.
     * @param nonces
     *     List (array) of all participants' nonces.
     * @param pubKeys
     *     List (array) of all participants' ephemeral public keys.
     * @param sessionSignature
     *     Signature to acknowledge the session.
     * @returns {SignatureKeyExchangeMessage}
     * 
     * @property source
     *     Sender participant ID of message.
     * @property dest
     *     Destination participatn ID of message (empty for broadcast).
     * @property flow
     *     Flow direction of message ('upflow' or 'downflow').
     * @property members
     *     Participant IDs of members.
     * @property nonces
     *     Nonces of members.
     * @property pubKeys
     *     Ephemeral public signing key of members.
     * @property sessionSignature
     *     Session acknowledgement signature using sender's static key.
     */
    mpenc.ske.SignatureKeyExchangeMessage = function(source, dest, flow, members,
                                                     nonces, pubKeys,
                                                     sessionSignature) {
        this.source = source || '';
        this.dest = dest || '';
        this.flow = flow || '';
        this.members = members || [];
        this.nonces = nonces || [];
        this.pubKeys = pubKeys || [];
        this.sessionSignature = sessionSignature || null;
        
        return this;
    };
    
    
    /**
     * Implementation of the authenticated signature key exchange.
     * 
     * This implementation is using Edwards25519 ECDSA signatures.
     * 
     * @constructor
     * @param id {string}
     *     Member's identifier string.
     * @returns {SignatureKeyExchangeMember}
     * 
     * @property id {string}
     *     Member's identifier string.
     * @property members
     *     List of all participants.
     * @property authenticatedMembers
     *     List of boolean authentication values for members.
     * @property ephemeralPrivKey
     *     Own ephemeral private signing key.
     * @property ephemeralPubKey
     *     Own ephemeral public signing key.
     * @property nonce
     *     Own nonce value for this session.
     * @property nonces
     *     Nonce values of members for this session.
     * @property ephemeralPubKeys
     *     Ephemeral signing keys for members.
     * @property sessionId
     *     Session ID of this session.
     * @property staticPrivKey
     *     Own static (long term) signing key.
     * @property staticPubKeyDir
     *     "Directory" of static public keys, using the participant ID as key. 
     * @property oldEphemeralKeys
     *     "Directory" of previous participants' ephemeral keys, using the
     *     participant ID as key. The entries contain an object with one or more of
     *     the members `priv`, `pub` and `authenticated` (if the key was
     *     successfully authenticated). 
     */
    mpenc.ske.SignatureKeyExchangeMember = function(id) {
        this.id = id;
        this.members = [];
        this.authenticatedMembers = null;
        this.ephemeralPrivKey = null;
        this.ephemeralPubKey = null;
        this.nonce = null;
        this.nonces = null;
        this.ephemeralPubKeys = null;
        this.sessionId = null;
        this.staticPrivKey = null;
        this.staticPubKeyDir = null;
        this.oldEphemeralKeys = {};
        return this;
    };
    
    
    /**
     * Start the upflow for the the commit (nonce values and ephemeral public keys).
     * 
     * @param otherMembers
     *     Iterable of other members for the group (excluding self).
     * @returns {SignatureKeyExchangeMessage}
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype.commit = function(otherMembers) {
        _assert(otherMembers && otherMembers.length !== 0, 'No members to add.');
        this.ephemeralPubKeys = null;
        var startMessage = new mpenc.ske.SignatureKeyExchangeMessage(this.id,
                                                                     '', 'upflow');
        startMessage.members = [this.id].concat(otherMembers);
        this.nonce = null;
        this.nonces = [];
        this.ephemeralPubKeys = [];
        return this.upflow(startMessage);
    };
    
    
    /**
     * SKE upflow phase message processing.
     * 
     * @param message
     *     Received upflow message. See {@link SignatureKeyExchangeMessage}.
     * @returns {SignatureKeyExchangeMessage}
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype.upflow = function(message) {
        _assert(mpenc.utils._noDuplicatesInList(message.members),
                'Duplicates in member list detected!');
        _assert(message.nonces.length <= message.members.length,
                'Too many nonces on ASKE upflow!');
        _assert(message.pubKeys.length <= message.members.length,
                'Too many pub keys on ASKE upflow!');
        var myPos = message.members.indexOf(this.id);
        _assert(myPos >= 0, 'Not member of this key exchange!');
    
        this.members = mpenc.utils.clone(message.members);
        this.nonces = mpenc.utils.clone(message.nonces);
        this.ephemeralPubKeys = mpenc.utils.clone(message.pubKeys);
        
        // Make new nonce and ephemeral signing key pair.
        this.nonce = djbec.bytes2string(mpenc.utils._newKey08(256));
        this.nonces.push(this.nonce);
        this.ephemeralPrivKey = djbec.bytes2string(mpenc.utils._newKey08(512));
        this.ephemeralPubKey = djbec.bytes2string(djbec.publickey(this.ephemeralPrivKey));
        this.ephemeralPubKeys.push(this.ephemeralPubKey);
        
        // Clone message.
        message = mpenc.utils.clone(message);
        
        // Pass on a message.
        if (myPos === this.members.length - 1) {
            // Compute my session ID.
            this.sessionId = mpenc.ske._computeSid(this.members, this.nonces);
            // I'm the last in the chain:
            // Broadcast own session authentication.
            message.source = this.id;
            message.dest = '';
            message.flow = 'downflow';
            this.authenticatedMembers = mpenc.utils._arrayMaker(this.members.length, false);
            this.authenticatedMembers[myPos] = true;
            message.sessionSignature = this._computeSessionSig();
        } else {
            // Pass a message on to the next in line.
            message.source = this.id;
            message.dest = this.members[myPos + 1];
        }
        message.nonces = mpenc.utils.clone(this.nonces);
        message.pubKeys = mpenc.utils.clone(this.ephemeralPubKeys);
        return message;
    };
    
    
    /**
     * Computes a session acknowledgement signature sigma(m) of a message
     * m = (pid_i, E_i, k_i, sid) using the static private key.
     * 
     * @returns
     *     Session signature.
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype._computeSessionSig = function() {
        _assert(this.sessionId, 'Session ID not available.');
        _assert(this.ephemeralPubKey, 'No ephemeral key pair available.');
        var sessionAck = this.id + this.ephemeralPubKey + this.nonce + this.sessionId;
        var hashValue = mpenc.utils.sha256(sessionAck);
        return mpenc.ske._smallrsasign(hashValue, this.staticPrivKey);
    };
    
    
    /**
     * Verifies a session acknowledgement signature sigma(m) of a message
     * m = (pid_i, E_i, k_i, sid) using the static public key.
     * 
     * @param memberId
     *     Participant ID of the member to verify the signature against.
     * @param signature
     *     Session acknowledgement signature.
     * @returns
     *     Whether the signature verifies against the member's static public key.
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype._verifySessionSig = function(memberId, signature) {
        _assert(this.sessionId, 'Session ID not available.');
        var memberPos = this.members.indexOf(memberId);
        _assert(memberPos >= 0, 'Member not in participants list.');
        _assert(this.ephemeralPubKeys[memberPos],
                "Member's ephemeral pub key missing.");
        _assert(this.staticPubKeyDir.get(memberId),
                "Member's static pub key missing.");
        var decrypted = mpenc.ske._smallrsaverify(signature,
                                                  this.staticPubKeyDir.get(memberId));
        var sessionAck = memberId + this.ephemeralPubKeys[memberPos]
                       + this.nonces[memberPos] + this.sessionId;
        var hashValue = mpenc.utils.sha256(sessionAck);
        return (decrypted === hashValue);
    };
    
    
    /**
     * SKE downflow phase message processing.
     * 
     * Returns null for the case that it has sent a downflow message already.
     * 
     * @param message
     *     Received downflow message. See {@link SignatureKeyExchangeMessage}.
     * @returns {SignatureKeyExchangeMessage} or null.
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype.downflow = function(message) {
        _assert(mpenc.utils._noDuplicatesInList(message.members),
                'Duplicates in member list detected!');
        var myPos = message.members.indexOf(this.id);
        
        // Generate session ID for received information.
        var sid = mpenc.ske._computeSid(message.members, message.nonces);
        
        // Is this a broadcast for a new session?
        var existingSession = (this.sessionId === sid);
        if (!existingSession) {
            this.members = mpenc.utils.clone(message.members);
            this.nonces = mpenc.utils.clone(message.nonces);
            this.ephemeralPubKeys = mpenc.utils.clone(message.pubKeys);
            this.sessionId = sid;
            
            // New authentication list, and authenticate myself.
            this.authenticatedMembers = mpenc.utils._arrayMaker(this.members.length, false);
            this.authenticatedMembers[myPos] = true;
        }
        
        // Verify the session authentication from sender.
        var isValid = this._verifySessionSig(message.source,
                                             message.sessionSignature);
        _assert(isValid, 'Authentication of member failed: ' + message.source);
        var senderPos = message.members.indexOf(message.source);
        this.authenticatedMembers[senderPos] = true;
        
        if (existingSession) {
            // We've acknowledged already, so no more broadcasts from us.
            return null;
        }
            
        // Clone message.
        message = mpenc.utils.clone(message);
        // We haven't acknowledged, yet, so pass on the message.
        message.source = this.id;
        message.sessionSignature = this._computeSessionSig();
        
        return message;
    };
    
    
    /**
     * Returns true if the authenticated signature key exchange is fully
     * acknowledged.
     * 
     * @returns True on a valid session.
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype.isSessionAcknowledged = function() {
        return this.authenticatedMembers.every(function(item) { return item; });
    };
    
    
    /**
     * Start a new upflow for joining new members.
     * 
     * @param newMembers
     *     Iterable of new members to join the group.
     * @returns {SignatureKeyExchangeMessage}
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype.join = function(newMembers) {
        _assert(newMembers && newMembers.length !== 0, 'No members to add.');
        var allMembers = this.members.concat(newMembers);
        _assert(mpenc.utils._noDuplicatesInList(allMembers),
                'Duplicates in member list detected!');
        this.members = allMembers;
        
        // Pass a message on to the first new member to join.
        var startMessage = new mpenc.ske.SignatureKeyExchangeMessage(this.id,
                                                                     '', 'upflow');
        startMessage.dest = newMembers[0];
        startMessage.members = mpenc.utils.clone(allMembers);
        startMessage.nonces = mpenc.utils.clone(this.nonces);
        startMessage.pubKeys = mpenc.utils.clone(this.ephemeralPubKeys);
        
        return startMessage;
    };
    
    
    /**
     * Start a new downflow for excluding members.
     * 
     * @param excludeMembers
     *     Iterable of members to exclude from the group.
     * @returns {SignatureKeyExchangeMessage}
     * @method
     */
    mpenc.ske.SignatureKeyExchangeMember.prototype.exclude = function(excludeMembers) {
        _assert(excludeMembers && excludeMembers.length !== 0, 'No members to exclude.');
        _assert(mpenc.utils._arrayIsSubSet(excludeMembers, this.members),
                'Members list to exclude is not a sub-set of previous members!');
        _assert(excludeMembers.indexOf(this.id) < 0,
                'Cannot exclude mysefl.');
        
        // Kick 'em.
        for (var i = 0; i < excludeMembers.length; i++) {
            var index = this.members.indexOf(excludeMembers[i]);
            this.oldEphemeralKeys[excludeMembers[i]] = {
                'pub': this.ephemeralPubKeys[index] || null,
                'authenticated': this.authenticatedMembers[index] || false,
            };
            this.members.splice(index, 1);
            this.nonces.splice(index, 1);
            this.ephemeralPubKeys.splice(index, 1);
        }
        
        // Compute my session ID.
        this.sessionId = mpenc.ske._computeSid(this.members, this.nonces);
        
        // Discard old and make new group key.
        var myPos = this.members.indexOf(this.id);
        this.authenticatedMembers = mpenc.utils._arrayMaker(this.members.length, false);
        this.authenticatedMembers[myPos] = true;
        
        // Pass broadcast message on to all members.
        var broadcastMessage = new mpenc.ske.SignatureKeyExchangeMessage(this.id,
                                                                         '', 'downflow');
        broadcastMessage.members = mpenc.utils.clone(this.members);
        broadcastMessage.nonces = mpenc.utils.clone(this.nonces);
        broadcastMessage.pubKeys = mpenc.utils.clone(this.ephemeralPubKeys);
        broadcastMessage.sessionSignature = this._computeSessionSig();
        
        return broadcastMessage;
    };
    
    
    /**
     * Converts a (binary) string to a multi-precision integer (MPI).
     * 
     * @param binstring
     *     Binary string representation of data.
     * @returns
     *     MPI representation.
     */
    mpenc.ske._binstring2mpi = function(binstring) {
        var contentLength = binstring.length * 8;
        var data = String.fromCharCode(contentLength >> 8)
                 + String.fromCharCode(contentLength & 255) + binstring;
        return mpi2b(data);
    };
    
    
    /**
     * Converts a multi-precision integer (MPI) to a (binary) string.
     * 
     * @param mpi
     *     MPI representation.
     * @returns
     *     Binary string representation of data.
     */
    mpenc.ske._mpi2binstring = function(mpi) {
        return b2mpi(mpi).slice(2);
    };
    
    /**
     * Encodes the message according to the EME-PKCS1-V1_5 encoding scheme in
     * RFC 2437, section 9.1.2.
     * 
     * see: http://tools.ietf.org/html/rfc2437#section-9.1.2
     * 
     * @param message
     *     Message to encode.
     * @param length
     *     Destination length of the encoded message in bytes.
     * @returns
     *     Encoded message as binary string.
     */
    mpenc.ske._pkcs1v15_encode = function(message, length) {
        _assert(message.length < length - 10,
                'message too long for encoding scheme');
        
        // Padding string.
        // TODO: Replace this with cryptographically secure random numbers.
        var padding = '';
        for (var i = 0; i < length - message.length - 2; i++) {
            padding += String.fromCharCode(1 + Math.floor(255 * Math.random()));
        }
        
        return String.fromCharCode(2) + padding + String.fromCharCode(0) + message;
    };
    
    
    /**
     * Decodes the message according to the EME-PKCS1-V1_5 encoding scheme in
     * RFC 2437, section 9.1.2.
     * 
     * see: http://tools.ietf.org/html/rfc2437#section-9.1.2
     * 
     * @param message
     *     Message to decode.
     * @returns
     *     Decoded message as binary string.
     */
    mpenc.ske._pkcs1v15_decode = function(message) {
        _assert(message.length > 10, 'message decoding error');
        return message.slice(message.indexOf(String.fromCharCode(0)) + 1);
    };
    
    
    /**
     * Encrypts a binary string using an RSA public key. The data to be encrypted
     * must be encryptable <em>directly</em> using the key.
     * 
     * For secure random padding, the max. size of message = key size in bytes - 10.
     * 
     * @param cleartext
     *     Cleartext to encrypt.
     * @param pubkey
     *     Public RSA key.
     * @returns
     *     Ciphertext encoded as binary string.
     */
    mpenc.ske._smallrsaencrypt = function(cleartext, pubkey) {
        // pubkey[2] is length of key in bits.
        var keyLength = pubkey[2] >> 3;
        
        // Convert to MPI format and return cipher as binary string.
        var data = mpenc.ske._binstring2mpi(mpenc.ske._pkcs1v15_encode(cleartext,
                                                                       keyLength));
        return mpenc.ske._mpi2binstring(RSAencrypt(data, pubkey[1], pubkey[0]));
    };
    
    
    /**
     * Decrypts a binary string using an RSA private key. The data to be decrypted
     * must be decryptable <em>directly</em> using the key.
     * 
     * @param ciphertext
     *     Ciphertext to decrypt.
     * @param privkey
     *     Private RSA key.
     * @returns
     *     Cleartext encoded as binary string.
     */
    mpenc.ske._smallrsadecrypt = function(ciphertext, privkey) {
        var cleartext = RSAdecrypt(mpenc.ske._binstring2mpi(ciphertext),
                                   privkey[2], privkey[0], privkey[1], privkey[3]);
        var data = mpenc.ske._mpi2binstring(cleartext);
        return mpenc.ske._pkcs1v15_decode(data);
    };
    
    
    /**
     * Encrypts a binary string using an RSA private key for the purpose of signing
     * (authenticating). The data to be encrypted must be decryptable
     * <em>directly</em> using the key.
     * 
     * For secure random padding, the max. size of message = key size in bytes - 10.
     * 
     * @param cleartext
     *     Message to encrypt.
     * @param privkey
     *     Private RSA key.
     * @returns
     *     Encrypted message encoded as binary string.
     */
    mpenc.ske._smallrsasign = function(cleartext, privkey) {
        var keyLength = (privkey[2].length * 28 - 1) >> 5 << 2;
            
        // Convert to MPI format and return cipher as binary string.
        var data = mpenc.ske._pkcs1v15_encode(cleartext, keyLength);
        // Decrypt ciphertext.
        var cipher = RSAdecrypt(mpenc.ske._binstring2mpi(data),
                                privkey[2], privkey[0], privkey[1], privkey[3]);
        return mpenc.ske._mpi2binstring(cipher);
    };
    
    
    /**
     * Encrypts a binary string using an RSA public key. The data to be encrypted
     * must be encryptable <em>directly</em> using the key.
     * 
     * @param ciphertext
     *     Ciphertext to encrypt.
     * @param pubkey
     *     Public RSA key.
     * @returns
     *     Cleartext encoded as binary string.
     */
    mpenc.ske._smallrsaverify = function(ciphertext, pubkey) {
        // Convert to MPI format and return cleartext as binary string.
        var data = mpenc.ske._binstring2mpi(ciphertext);
        var cleartext = mpenc.ske._mpi2binstring(RSAencrypt(data, pubkey[1], pubkey[0]));
        return mpenc.ske._pkcs1v15_decode(cleartext);
    };
    
    
    /**
     * Encrypts a binary string using an RSA public key. The data to be encrypted
     * must be encryptable <em>directly</em> using the key.
     * 
     * @param members
     *     Members participating in protocol.
     * @param nonces
     *     Nonces of the members in matching order.
     * @returns
     *     Session ID as binary string.
     */
    mpenc.ske._computeSid = function(members, nonces) {
        // Create a mapping to access sorted/paired items later.
        var mapping = {};
        for (var i = 0; i < members.length; i++) {
            mapping[members[i]] = nonces[i];
        }
        var sortedMembers = members.concat();
        sortedMembers.sort();
        
        // Compose the item chain.
        var pidItems = '';
        var nonceItems = '';
        for (var i = 0; i < sortedMembers.length; i++) {
            var pid = sortedMembers[i];
            if (pid) {
                pidItems += pid;
                nonceItems += mapping[pid];
            }
        }
        return mpenc.utils.sha256(pidItems + nonceItems);
    };
})();
