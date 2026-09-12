/**
 * @file Reusable soft-delete plugin.
 *
 * All three collections in this phase are soft-deleted rather than destroyed:
 * an industrial audit trail must be able to answer "what did this asset look
 * like last March?", and a hard `deleteOne` makes that impossible.
 *
 * Design choice — **no automatic query filtering.** A common implementation
 * registers `pre('find')` hooks that silently inject `isDeleted: false` into
 * every query. That is convenient right up until someone spends an afternoon
 * wondering why a document they can see in Compass is invisible to the API.
 * Instead this plugin exposes explicit helpers (`Model.findActive(...)`), so
 * every read states its intent at the call site.
 *
 * @module models/plugins/softDelete.plugin
 */

/**
 * Mongoose plugin adding soft-delete fields, helpers, and statics.
 *
 * @param {import('mongoose').Schema} schema - Schema being extended.
 * @returns {void}
 */
export function softDeletePlugin(schema) {
  schema.add({
    /** Whether this document is logically deleted. */
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** When the document was soft-deleted; `null` while live. */
    deletedAt: {
      type: Date,
      default: null,
    },
  });

  /**
   * Mark this document deleted and persist the change.
   *
   * @param {object} [options]
   * @param {import('mongoose').ClientSession|null} [options.session] - Session
   *   to enlist the write in, when called from inside a transaction.
   * @returns {Promise<import('mongoose').Document>} The saved document.
   * @this {import('mongoose').Document & { isDeleted: boolean, deletedAt: Date|null }}
   */
  schema.methods.softDelete = async function softDelete({ session = null } = {}) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    return this.save({ session });
  };

  /**
   * Restore a previously soft-deleted document.
   *
   * @param {object} [options]
   * @param {import('mongoose').ClientSession|null} [options.session]
   * @returns {Promise<import('mongoose').Document>} The saved document.
   * @this {import('mongoose').Document & { isDeleted: boolean, deletedAt: Date|null }}
   */
  schema.methods.restore = async function restore({ session = null } = {}) {
    this.isDeleted = false;
    this.deletedAt = null;
    return this.save({ session });
  };

  /**
   * `Model.find` restricted to live documents.
   *
   * @param {object} [filter] - Additional query conditions.
   * @returns {import('mongoose').Query<any, any>} Chainable query.
   * @this {import('mongoose').Model<any>}
   */
  schema.statics.findActive = function findActive(filter = {}) {
    return this.find({ ...filter, isDeleted: false });
  };

  /**
   * `Model.findOne` restricted to live documents.
   *
   * @param {object} [filter] - Additional query conditions.
   * @returns {import('mongoose').Query<any, any>} Chainable query.
   * @this {import('mongoose').Model<any>}
   */
  schema.statics.findOneActive = function findOneActive(filter = {}) {
    return this.findOne({ ...filter, isDeleted: false });
  };

  /**
   * `Model.findById` restricted to live documents.
   *
   * @param {string|import('mongoose').Types.ObjectId} id - Document id.
   * @returns {import('mongoose').Query<any, any>} Chainable query.
   * @this {import('mongoose').Model<any>}
   */
  schema.statics.findActiveById = function findActiveById(id) {
    return this.findOne({ _id: id, isDeleted: false });
  };

  /**
   * `Model.countDocuments` restricted to live documents.
   *
   * @param {object} [filter] - Additional query conditions.
   * @returns {import('mongoose').Query<number, any>} Chainable count query.
   * @this {import('mongoose').Model<any>}
   */
  schema.statics.countActive = function countActive(filter = {}) {
    return this.countDocuments({ ...filter, isDeleted: false });
  };
}

export default softDeletePlugin;
