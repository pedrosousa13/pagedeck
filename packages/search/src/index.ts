export { defineSearch } from "./search.js";
// `QUERY_CAP` rides the index, not `./query`: re-exported there it would pull the indexer
// into a reader's bundle.
export { QUERY_CAP } from "./shards.js";
