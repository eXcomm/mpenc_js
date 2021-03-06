/*
 * Created: 10 Feb 2015 Ximin Luo <xl@mega.co.nz>
 *
 * (c) 2015-2016 by Mega Limited, Wellsford, New Zealand
 *     https://mega.nz/
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

define([
    "mpenc/transcript",
    "mpenc/message",
    "mpenc/helper/assert",
    "mpenc/helper/async",
    "mpenc/helper/graph",
    "mpenc/helper/struct",
    "megalogger",
    "es6-collections",
], function(
    transcript, message, assert, async, graph, struct,
    MegaLogger, es6_shim
) {
    "use strict";

    /**
     * @exports mpenc/impl/transcript
     * @private
     * @description
     * Transcript implementation.
     */
    var ns = {};

    var logger = MegaLogger.getLogger("transcript", undefined, "mpenc");
    var _assert = assert.assert;

    var MessageLog = transcript.MessageLog;
    var ObservableSequence = async.ObservableSequence;
    var ImmutableSet = struct.ImmutableSet;
    var safeGet = struct.safeGet;

    /**
     * A set of BaseTranscript forming all or part of a session.
     *
     * @class
     * @private
     * @memberOf module:mpenc/impl/transcript
     * @implements {module:mpenc/transcript.Transcript}
     */
    var BaseTranscript = function() {
        if (!(this instanceof BaseTranscript)) { return new BaseTranscript(); }

        this._uIds = ImmutableSet.EMPTY;
        this._messages = new Map();
        this._minMessages = ImmutableSet.EMPTY;
        this._maxMessages = ImmutableSet.EMPTY;

        this._successors = new Map(); // mId: Set[mId], successors

        // overall sequence. only meaningful internally
        this._length = 0;
        this._messageIndex = new Map(); // mId: int, index into _log
        this._log = [];

        // per-author sequence. only meaningful internally. like a local vector clock.
        this._authorMessages = new Map(); // uId: [mId], messages in the order they were authored
        this._authorIndex = new Map(); // mId: int, index into _authorMessages[mId's author]

        this._context = new Map(); // mId: uId: mId1, latest message sent by uId before mId, or null

        this._unackby = new Map(); // mId: Set[uId], readers of mId that we have not yet seen ack it
        this._unacked = ImmutableSet.EMPTY; // Set[mId] of not fully-acked messages

        var self = this;
        this._merge = graph.createMerger(
            function(m) { return self.pre(m).toArray(); },
            function(m) { return self.suc(m).toArray(); },
            function(a, b) { return self.le(a, b); },
            function(m) { return self._messages.get(m).members(); },
            ImmutableSet,
            function(p, a, b) { return p.merge(a, b); });
        this._fubar = false;

        this._invalidateCaches();
    };

    BaseTranscript.prototype._invalidateCaches = function(uId) {
        this._cacheUnacked = null;
        if (!uId) {
            this._cacheBy = new Map();
        } else {
            this._cacheBy.delete(uId);
        }
    };

    BaseTranscript.prototype._mergeContext = function(pmId, ruId) {
        var self = this;
        var context = new Map();
        pmId.forEach(function(m) {
            var mc = self._context.get(m);
            mc.forEach(function(um, u) {
                if (!context.has(u) || context.get(u) === null ||
                    (um !== null && self.ge(um, context.get(u)))) {
                    context.set(u, um);
                }
            });
        });
        pmId.forEach(function(m) { context.set(self.author(m), m); });
        ruId.forEach(function(u) { if (!context.has(u)) { context.set(u, null); } });
        context.forEach(function(_, pu) { if (!ruId.has(pu)) { context.delete(pu); }});
        return context;
    };

    BaseTranscript.prototype._sortMIds = function(mIds) {
        var self = this;
        mIds.sort(function(a, b) { return self._messageIndex.get(a) - self._messageIndex.get(b); });
        return mIds;
    };

    // CausalOrder

    BaseTranscript.prototype.size = function() {
        return this._length;
    };

    BaseTranscript.prototype.all = function() {
        return this._log.slice(); // TODO: P- could be optimised with a cache
    };

    BaseTranscript.prototype.has = function(mId) {
        return this._messages.has(mId);
    };

    BaseTranscript.prototype.min = function() {
        return this._minMessages;
    };

    BaseTranscript.prototype.max = function() {
        return this._maxMessages;
    };

    BaseTranscript.prototype.pre = function(mId) {
        return safeGet(this._messages, mId).parents;
    };

    BaseTranscript.prototype.suc = function(mId) {
        return safeGet(this._successors, mId);
    };

    BaseTranscript.prototype.le = function(m0, m1) {
        if (m0 === undefined || m1 === undefined) {
            throw new Error("le: m0 and m1 are not both defined: " + m0 + " vs " + m1);
        } else if (m0 === m1) {
            return true;
        }

        var u0 = this.author(m0);
        var u1 = this.author(m1);
        // author() throws if param doesn't exist, so no need to safeGet from here

        if (u0 === u1) {
            return this._authorIndex.get(m0) <= this._authorIndex.get(m1);
        } else if (this._messages.get(m1).readers.has(u0)) {
            var p0 = this._context.get(m1).get(u0);
            return p0 !== null && this._authorIndex.get(m0) <= this._authorIndex.get(p0);
        } else {

            var i0 = this._messageIndex.get(m0);
            var i1 = this._messageIndex.get(m1);
            if (i0 > i1) {
                return false;
            } else {
                return this._le_expensive(m0, m1);
            }
        }
    };

    BaseTranscript.prototype._le_expensive = function(m0, m1) {
        // TODO: P- as per python prototype, this could be a BFS and/or cached,
        // but we optimise a lot already before we get to this stage so the
        // added complexity may not be worth it
        var pre = this.pre(m1).toArray();
        for (var i=0; i<pre.length; i++) {
            if (this.le(m0, pre[i])) {
                return true;
            }
        }
        return false;
    };

    BaseTranscript.prototype.ge = function(m0, m1) {
        return this.le(m1, m0);
    };

    BaseTranscript.prototype.allAuthors = function() {
        return this._uIds;
    };

    BaseTranscript.prototype.author = function(mId) {
        return safeGet(this._messages, mId).author;
    };

    BaseTranscript.prototype.by = function(uId) {
        if (!this._cacheBy.has(uId)) {
            var msg = safeGet(this._authorMessages, uId).slice();
            Object.freeze(msg);
            this._cacheBy.set(uId, msg);
        }
        return this._cacheBy.get(uId);
    };

    BaseTranscript.prototype.iterAncestors = graph.CausalOrder.prototype.iterAncestors;

    BaseTranscript.prototype.iterDescendants = graph.CausalOrder.prototype.iterDescendants;

    // Messages

    BaseTranscript.prototype.get = function(mId) {
        return safeGet(this._messages, mId);
    };

    BaseTranscript.prototype.parents = BaseTranscript.prototype.pre;

    BaseTranscript.prototype.unackby = function(mId) {
        return safeGet(this._unackby, mId);
    };

    BaseTranscript.prototype.unacked = function() {
        if (!this._cacheUnacked) {
            var unacked = this._sortMIds(this._unacked.toArray());
            Object.freeze(unacked);
            this._cacheUnacked = unacked;
        }
        return this._cacheUnacked;
    };

    // own public

    /**
     * Add/accept a message; all its parents must already have been added.
     *
     * @method
     * @param msg {module:mpenc/message.Message} Message to add.
     * @returns {Array.<string>} List of older messages that became fully-acked
     * by this message being accepted, in some topological order.
     */
    BaseTranscript.prototype.add = function(msg) {
        if (this._fubar) {
            throw new Error("something horrible happened previously, refusing all operations");
        }

        var self = this;
        var mId = msg.mId, uId = msg.author, pmId = msg.parents, ruId = msg.readers;
        // last message by the same author
        var pumId = this._authorMessages.has(uId)? this._authorMessages.get(uId).slice(-1)[0]: null;
        var pmIdArr = pmId.toArray();

        // sanity checks

        if (mId === null) {
            throw new Error("invalid mId: null");
        }

        if (pmId.has(mId)) {
            throw new Error("message references itself: " + btoa(mId) + " in " + pmIdArr.map(btoa));
        }

        if (this._messages.has(mId)) {
            throw new Error("message already added: " + btoa(mId));
        }

        if (uId === null) {
            throw new Error("invalid uId: null");
        }

        if (ruId.has(uId)) {
            throw new Error("message sent to self: " + uId + " in " + ruId);
        }

        if (ruId.size === 0) {
            // in principle, can support empty room talking to yourself
            logger.warn("message has no readers: " + btoa(mId));
        }

        // ensure graph is complete, also preventing cycles
        var pmId404 = pmId.subtract(this._messages);
        if (pmId404.size > 0) {
            throw new Error("parents not found: " + pmId404.toArray().map(btoa));
        }

        // check sender is actually allowed to read the parents
        var pmId403 = pmIdArr.filter(function(pm) {
            return !self._messages.get(pm).members().has(uId);
        });
        if (pmId403.length > 0) {
            throw new Error("secret parents referenced: " + pmId403.toArray().map(btoa));
        }

        // check sanity of parents
        if (pmId.size >
            new ImmutableSet(pmIdArr.map(function(m) { return self.author(m); })).size) {
            throw new Error("redundant parents: not from distinct authors");
        }

        // invariant: total-ordering of one user's messages
        // can't check mId directly since it's not in the graph yet, so check parents
        if (pumId !== null) {
            if (!pmIdArr.some(function(m) { return self.le(pumId, m); })) {
                throw new Error("" + btoa(mId) + " does not reference prev-sent " + pumId);
            }
        }

        // merging the members checks they are in different chains, which ensures
        // transitive reduction and freshness consistency (see msg-notes)
        var merged = this._merge(pmId);

        var context = this._mergeContext(pmId, ruId);

        // update state
        // no turning back now; any exceptions raised from here onwards will lead
        // to inconsistent state and is a programming error.

        try {
            // update core
            var mIdS = new ImmutableSet([mId]);
            this._uIds = this._uIds.union(new ImmutableSet([uId]));
            this._messages.set(mId, msg);
            if (!pmId.size) {
                this._minMessages = this._minMessages.union(mIdS);
            }
            this._maxMessages = this._maxMessages.union(mIdS).subtract(pmId);

            // update successors
            pmId.forEach(function(m) {
                self._successors.set(m, self._successors.get(m).union(mIdS));
            });
            this._successors.set(mId, ImmutableSet.EMPTY);

            // update overall sequences
            this._messageIndex.set(mId, this._length);
            this._log.push(mId);
            this._length++;

            // update per-author sequences
            if (pumId === null) {
                this._authorMessages.set(uId, []);
            }
            this._authorMessages.get(uId).push(mId);
            var mSeq = this._authorMessages.get(uId).length - 1;
            this._authorIndex.set(mId, mSeq);

            // update context
            this._context.set(mId, context);

            // update unacked
            this._unackby.set(mId, ruId);
            this._unacked = this._unacked.union(mIdS);
            var anc = this.iterAncestors(pmIdArr, function(m) { return self._unackby.get(m).has(uId); });
            var acked = new Set();
            if (!ruId.size) {
                acked.add(mId);
            }
            struct.iteratorForEach(anc, function(am) {
                self._unackby.set(am, self._unackby.get(am).subtract(new ImmutableSet([uId])));
                if (!self._unackby.get(am).size) {
                    acked.add(am);
                }
            });
            this._unacked = this._unacked.subtract(acked);
            acked = this._sortMIds(struct.iteratorToArray(acked.values()));

            this._invalidateCaches(uId);

            return acked;
        } catch (e) {
            this._fubar = true;
            throw e;
        }
    };

    // Transcript

    BaseTranscript.prototype.pre_uId = function(mId) {
        var i = safeGet(this._authorIndex, mId);
        var uId = this.author(mId);
        return (i)? this._authorMessages.get(uId)[i]: null;
    };

    BaseTranscript.prototype.pre_ruId = function(mId, ruId) {
        if (ruId === undefined) {
            return new Map(safeGet(this._context, mId).entries());
        } else {
            return safeGet(safeGet(this._context, mId), ruId);
        }
    };

    BaseTranscript.prototype.pre_pred = function(mId, pred) {
        var it = this.iterAncestors(this.pre(mId).toArray(),
            null, function(mId) { return !pred(mId); }, true);
        return new ImmutableSet(struct.iteratorToArray(it));
    };

    BaseTranscript.prototype.suc_ruId = function(mId, ruId) {
        if (ruId === undefined) {
            throw new Error("not implemented");
        }
        if (!this._messages.get(mId).readers.has(ruId)) {
            throw new ReferenceError("invalid reader: " + ruId);
        }
        var self = this;
        var visible = function(m) { return self._messages.get(m).members().has(ruId); };
        var it = this.iterDescendants([mId], visible, function(m) { return ruId !== self.author(m); }, true);
        var next = it.next();
        return (next.done) ? null : next.value;
    };

    BaseTranscript.prototype.mergeMembers = function(parents) {
        return this._merge(parents);
    };

    Object.freeze(BaseTranscript.prototype);
    ns.BaseTranscript = BaseTranscript;


    /**
     * MessageLog that orders messages in the same way as the accept-order.
     *
     * Much of the code could be reused if we ever want to do different UI
     * orderings; for now we'll avoid too many levels of inheritance.
     *
     * @class
     * @private
     * @extends {module:mpenc/helper/async.ObservableSequence}
     * @implements {module:mpenc/transcript.MessageLog}
     * @memberOf module:mpenc/impl/transcript
     */
    var DefaultMessageLog = function() {
        if (!(this instanceof DefaultMessageLog)) { return new DefaultMessageLog(); }
        ObservableSequence.call(this);
        this._messageIndex = new Map(); // mId: int, index into self as an Array
        this._parents = []; // [ImmutableSet([mId of parents])]
        this._transcripts = new Set();
        this._transcriptParents = new Map();
        this._lastTranscript = null;
    };

    DefaultMessageLog.prototype = Object.create(ObservableSequence.prototype);

    /**
     * Add a message to the log, at an index defined by the implementation.
     *
     * Subscribers to the ObservableSequence trait of this class are notified.
     *
     * @method
     * @param transcript {module:mpenc/transcript.Transcript} Transcript object that contains the message.
     * @param mId {string} Identifier of the message to add.
     * @param parents {string} Effective Payload parents of this message.
     */
    DefaultMessageLog.prototype._add = function(transcript, mId, parents) {
        if (this._messageIndex.has(mId)) {
            throw new Error("already added: " + btoa(mId));
        }
        if (MessageLog.shouldIgnore(transcript, mId)) {
            return;
        }
        parents = ImmutableSet.from(parents);
        if (!parents.size) {
            // if this message is a minimum for this transcript, then use
            // transcript's parents instead, available externally,
            var trParents = this._transcriptParents.get(transcript);
            if (trParents && trParents.size) {
                _assert(trParents.toArray().every(this.has.bind(this)));
                parents = trParents;
                logger.info("DefaultMessageLog replaced empty parents of " + btoa(mId) +
                    " with: {" + parents.toArray().map(btoa) + "}");
            }
        }
        this._transcripts.add(transcript);
        this._messageIndex.set(mId, this.length);
        this._parents.push(parents);
        this.push(mId);
        this.__rInsert__(0, mId);
    };

    // Resolve some mIds to latest earlier Payload mIds, "falling back" to that
    // of the previous transcript, if the former set is empty.
    DefaultMessageLog.prototype._resolveEarlier = function(tscr, mIds) {
        _assert(this._transcriptParents.has(tscr), "invalid transcript: " + tscr);
        var resolved = MessageLog.resolveEarlier(tscr, mIds);
        if (!resolved.size) {
            resolved = this._transcriptParents.get(tscr);
        }
        _assert(resolved.toArray().every(this.has.bind(this)),
            "resolved parents not all added to the log yet; this must be done first");
        return resolved;
    };

    /**
     * Create a subscriber to handle messages that are accepted into the given
     * Transcript. This should only be called once for a given transcript.
     *
     * Whenever the subscriber receives a message ID, which must already be in
     * the Transcript, add it to this log too but only if it passes the
     * `MessageLog.shouldIgnore` test.
     *
     * @method
     * @protected
     * @param transcript {module:mpenc/transcript.Transcript}
     *      Transcript object that contains the message.
     * @param [parents] {Map} Map of `{ ImmutableSet([MessageID]): Transcript }`,
     *      the latest messages to occur before the event that created `transcript`,
     *      partitioned by the parent Transcript that the messages belong to.
     * @returns {module:mpenc/helper/async~subscriber} 1-arg subscriber
     *      function, that takes a message-ID (string) and returns undefined.
     */
    DefaultMessageLog.prototype.getSubscriberFor = function(transcript, parents) {
        if (parents && parents.size > 1) {
            throw new Error("DefaultMessageLog does not support transcripts with > 1 parent");
        }
        var parentVal = (parents && parents.size) ? parents.entries().next().value : null;
        var parentMIds = parentVal ? ImmutableSet.from(parentVal[0]) : ImmutableSet.EMPTY;
        // note that payloadParents may belong to an ancestor, and not parentTscr itself
        var payloadParents = parentVal ?
            this._resolveEarlier(parentVal[1], parentMIds) : ImmutableSet.EMPTY;
        this._transcriptParents.set(transcript, payloadParents);
        this._lastTranscript = transcript;

        var self = this;
        return function(mId) {
            _assert(transcript.has(mId));
            if (MessageLog.shouldIgnore(transcript, mId)) {
                return;
            }
            self._add(transcript, mId,
                MessageLog.resolveEarlier(transcript, transcript.pre(mId)));
        };
    };

    DefaultMessageLog.prototype._getTranscript = function(mId) {
        var targetTranscript;
        this._transcripts.forEach(function(ts) {
            if (ts.has(mId) && !MessageLog.shouldIgnore(ts, mId)) {
                targetTranscript = ts;
            }
        });
        if (targetTranscript) {
            return targetTranscript;
        } else {
            throw new Error("transcript not found for mId:" + btoa(mId));
        }
    };

    // MessageLog

    DefaultMessageLog.prototype.at = function(index) {
        return this[(index < 0) ? this.length + index : index];
    };

    DefaultMessageLog.prototype.indexOf = function(mId) {
        return this._messageIndex.has(mId) ? this._messageIndex.get(mId) : -1;
    };

    DefaultMessageLog.prototype.curParents = function() {
        var lastTs = this._lastTranscript;
        return lastTs ? this._resolveEarlier(lastTs, lastTs.max()) : ImmutableSet.EMPTY;
    };

    // length, slice, already implemented by ObservableSequence via Array

    // Messages

    DefaultMessageLog.prototype.has = function(mId) {
        return this._messageIndex.has(mId);
    };

    DefaultMessageLog.prototype.get = function(mId) {
        return safeGet(this._getTranscript(mId), mId);
    };

    DefaultMessageLog.prototype.parents = function(mId) {
        return this._parents[safeGet(this._messageIndex, mId)];
    };

    DefaultMessageLog.prototype.unackby = function(mId) {
        return this._getTranscript(mId).unackby(mId);
    };

    DefaultMessageLog.prototype.unacked = function() {
        var unacked = [];
        var self = this;
        this._transcripts.forEach(function(ts) {
            unacked.push.apply(unacked, ts.unacked().filter(function(m) {
                return self.has(m);
            }));
        });
        unacked.sort(function(a, b) {
            var ia = self._messageIndex.get(a), ib = self._messageIndex.get(b);
            return (ia < ib)? -1: (ia === ib)? 0: 1;
        });
        return unacked;
    };

    Object.freeze(DefaultMessageLog.prototype);
    ns.DefaultMessageLog = DefaultMessageLog;


    return ns;
});
