const nearApi = require("near-api-js");

const BN = require("bn.js");

const { nearRpcUrl, wampNearNetworkName } = require("./config");
const { queryNodeValidators } = require("./db-utils");

const nearRpc = new nearApi.providers.JsonRpcProvider(nearRpcUrl);

let seatPrice = null;
let totalStake = null;
let poolDetails = null;
let currentEpochStartHeight = null;
let totalValidatorsPool = new Map();

// TODO: Provide an equivalent method in near-api-js, so we don't need to hack it around.
nearRpc.callViewMethod = async function (contractName, methodName, args) {
  const account = new nearApi.Account({ provider: this });
  return await account.viewFunction(contractName, methodName, args);
};

const queryFinalBlock = async () => {
  return await nearRpc.sendJsonRpc("block", { finality: "final" });
};

const queryEpochStats = async () => {
  const networkProtocolConfig = await nearRpc.sendJsonRpc(
    "EXPERIMENTAL_protocol_config",
    { finality: "final" }
  );
  const epochStatus = await nearRpc.sendJsonRpc("validators", [null]);
  const numSeats =
    networkProtocolConfig.num_block_producer_seats +
    networkProtocolConfig.avg_hidden_validator_seats_per_shard.reduce(
      (a, b) => a + b
    );

  const currentProposals = epochStatus.current_proposals;
  const currentValidators = getCurrentNodes(epochStatus);
  const currentPools = await queryNodeValidators();

  if (wampNearNetworkName === "mainnet") {
    poolDetails = await nearRpc.callViewMethod("name.near", "get_all_fields", {
      from_index: 0,
      limit: 100,
    });
  }

  currentValidators.forEach((validator, i) => {
    if (!currentValidators[i].validatorStatus) {
      currentValidators[i].validatorStatus = "active";
    }
    totalValidatorsPool.set(validator.account_id, validator);
  });

  currentProposals.forEach((proposal) => {
    const activeValidator = totalValidatorsPool.get(proposal.account_id);
    if (activeValidator) {
      totalValidatorsPool.set(proposal.account_id, {
        ...activeValidator,
        stakeProposed: proposal.stake,
      });
    } else {
      totalValidatorsPool.set(proposal.account_id, {
        ...proposal,
        validatorStatus: "proposal",
      });
    }
  });

  currentPools.forEach((pool) => {
    const activePool = totalValidatorsPool.get(pool.account_id);
    if (activePool) {
      totalValidatorsPool.set(pool.account_id, {
        ...activePool,
        poolDetails:
          wampNearNetworkName === "mainnet"
            ? { ...poolDetails[pool.account_id] }
            : null,
      });
    } else {
      totalValidatorsPool.set(pool.account_id, {
        account_id: pool.account_id,
        poolDetails:
          wampNearNetworkName === "mainnet"
            ? { ...poolDetails[pool.account_id] }
            : null,
      });
    }
  });

  const { epoch_start_height: epochStartHeight } = epochStatus;
  const {
    epoch_length: epochLength,
    genesis_time: genesisTime,
    genesis_height: genesisHeight,
    protocol_version: epochProtocolVersion,
  } = networkProtocolConfig;

  if (currentEpochStartHeight !== epochStartHeight) {
    // Update seat_price and total_stake each time when epoch starts
    currentEpochStartHeight = epochStartHeight;
    seatPrice = nearApi.validators
      .findSeatPrice(epochStatus.current_validators, numSeats)
      .toString();

    totalStake = currentValidators
      .reduce((acc, node) => acc.add(new BN(node.stake)), new BN(0))
      .toString();
  }

  return {
    epochLength,
    epochStartHeight,
    epochProtocolVersion,
    currentValidators,
    currentProposals,
    totalValidatorsPool,
    totalStake,
    seatPrice,
    genesisTime,
    genesisHeight,
  };
};

const setValidatorStatus = (validators, status) => {
  for (let i = 0; i < validators.length; i++) {
    validators[i].validatorStatus = status;
  }
};

const getCurrentNodes = (epochStatus) => {
  let {
    current_validators: currentValidators,
    next_validators: nextValidators,
  } = epochStatus;
  const {
    newValidators,
    removedValidators,
  } = nearApi.validators.diffEpochValidators(currentValidators, nextValidators);
  setValidatorStatus(newValidators, "new");
  setValidatorStatus(removedValidators, "leaving");
  currentValidators = currentValidators.concat(newValidators);
  return currentValidators;
};

exports.nearRpc = nearRpc;
exports.queryFinalBlock = queryFinalBlock;
exports.queryEpochStats = queryEpochStats;
