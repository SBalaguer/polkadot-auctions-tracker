// Import
import { ApiPromise, WsProvider } from '@polkadot/api';
import { argv } from 'node:process';
import parachainsInfo from './parachains.json' assert { type: "json" };

let chain;
let parachains;

console.log("starting")

argv.filter((val) => {
    const parsedVal = val.split("=");
    if (parsedVal[0] === 'chain') {
        if (parsedVal[1] === 'kusama'){
            chain = 'kusama';
            parachains = parachainsInfo.kusama
        } else {
            chain = 'polkadot'
            parachains = parachainsInfo.polkadot
        }
    } else {
        chain = 'polkadot'
        parachains = parachainsInfo.polkadot
    }
});

const buildApi = async (chain) => {
    let api
    switch (chain){
        case "kusama":
            const wsProviderKusama = new WsProvider('wss://kusama-rpc.polkadot.io');
            api = await ApiPromise.create({ provider: wsProviderKusama });  
            break;
        default:
            const wsProviderPolkadot = new WsProvider('wss://rpc.polkadot.io');
            api = await ApiPromise.create({ provider: wsProviderPolkadot });  
    }
    return api
}

const api = await buildApi(chain);

async function main () {

    // Get all constants
    const {durationEndingPeriod, slotOffset, leasePeriodDuration} = await getConstants();

    // Get averageBlockTimes -> this will help calculate target dates
    const {avgBlockTime, lastBlockNumber, lastBlockTimestamp} = await calculateAvgBlockTime();

    // Get information on ongoing Auction, if any
    const {isAuctionActive, activeAuctionInformation, currentAuctionLP, currentAuctionEndStartBlock} = await getCurrentAuction();

    const currentLeasePeriod = Math.floor((lastBlockNumber-slotOffset)/leasePeriodDuration)

    console.log("**************************")
    console.log("** CURRENT LEASE PERIOD **")
    console.log("**************************")
    console.log(currentLeasePeriod)

    const {allRemainingLeases} = await potentialRenewals(currentLeasePeriod)

    console.log("**************************")
    console.log("** ALL REMAINING LEASES **")
    console.log("**************************")
    console.log(allRemainingLeases)
    
    const {unlockPerLP} = await endingCrowdoans();
    
    // console.log("** CROWDLOAN UNLOCK AMOUNTS **")
    // console.log(unlockPerLP)

    
    // At this moment, there is information of an ongoing auction, if any, and the scheduled auctions.
    // The objective is to build an array of objects of all ongoing + scheduled auctions, and storte it on the parsedListOfAuctions array.

    console.log("**********************")
    console.log("** AUCTION SCHEDULE **")
    console.log("**********************")

    // Get Scheduled auctions
    const scheduledAuctions = await getScheduledActions();

    const parsedListOfAuctions = [];

    // if there's an ongoing auction, use scheduler information to fill information gaps.
    if (isAuctionActive){
        //in here the full information of the active auction can be rebuilt.
        scheduledAuctions.map((action) => {
            if (convertToNumber(action.call.Value.args.lease_period_index) === currentAuctionLP){
                //starting_period_block = (the start of the ending period) - duration on arguments for newAuction call on scheduler
                //TODO: where can I get this information if this is the last auction scheduled
                activeAuctionInformation.starting_period_block = currentAuctionEndStartBlock - convertToNumber(action.call.Value.args.duration)
            }
            //auction_end = (the start of the ending period) + duration of auction (constant on auction module)
            activeAuctionInformation.auction_end = currentAuctionEndStartBlock + durationEndingPeriod
        })

        parsedListOfAuctions.push(activeAuctionInformation)
    }

    //now on to the Scheduled Auctions
    scheduledAuctions.sort((a, b) => (a.blockExecution > b.blockExecution ? 1 : -1)).map(scheduledAuction =>{
        const iterations = scheduledAuction.maybePeriodic ? convertToNumber(scheduledAuction.maybePeriodic[1]) : 0;

        for (let i=0; i<=iterations; i++){
            if (!i){
                const startAuction = scheduledAuction.blockExecution
                const ending_period_start_block = startAuction + convertToNumber(scheduledAuction.call.Value.args.duration)
                const auction_end =  startAuction + convertToNumber(scheduledAuction.call.Value.args.duration) + durationEndingPeriod
                const newAuction = {
                    "starting_period_block": startAuction,
                    ending_period_start_block,
                    auction_end,
                    "first_lease_period": convertToNumber(scheduledAuction.call.Value.args.lease_period_index),
                    "auction_during_lp": Math.floor((startAuction-slotOffset)/leasePeriodDuration),
                    "starting_period_block_date": calculateTargetDate(lastBlockTimestamp, lastBlockNumber, startAuction, avgBlockTime),
                    "ending_period_start_block_date": calculateTargetDate(lastBlockTimestamp, lastBlockNumber, ending_period_start_block, avgBlockTime),
                    "auction_end_date": calculateTargetDate(lastBlockTimestamp, lastBlockNumber, auction_end, avgBlockTime),
                }
                parsedListOfAuctions.push(newAuction)
            }else{
                const startAuction = parsedListOfAuctions[parsedListOfAuctions.length-1].starting_period_block + convertToNumber(scheduledAuction.maybePeriodic[0])
                const ending_period_start_block = startAuction + convertToNumber(scheduledAuction.call.Value.args.duration);
                const auction_end = startAuction + convertToNumber(scheduledAuction.call.Value.args.duration) + durationEndingPeriod;
                const newAuction = {
                    "starting_period_block": startAuction,
                    ending_period_start_block,
                    auction_end,
                    "auction_during_lp": Math.floor((startAuction-slotOffset)/leasePeriodDuration),
                    "first_lease_period": convertToNumber(scheduledAuction.call.Value.args.lease_period_index),
                    "starting_period_block_date": calculateTargetDate(lastBlockTimestamp, lastBlockNumber, startAuction, avgBlockTime),
                    "ending_period_start_block_date": calculateTargetDate(lastBlockTimestamp, lastBlockNumber, ending_period_start_block, avgBlockTime),
                    "auction_end_date": calculateTargetDate(lastBlockTimestamp, lastBlockNumber, auction_end, avgBlockTime),
                }
                parsedListOfAuctions.push(newAuction)
            }
        }

    })

    console.log(parsedListOfAuctions)
    // console.log("avgBlockTime", avgBlockTime)
    return parsedListOfAuctions

}

const getConstants = async () => {

    //how long the ending period of an auction is.
    const durationEndingPeriod = await api.consts.auctions.endingPeriod.toNumber();
    
    //if there's an offset, in number of blocks, to the start of the first lease period.
    const slotOffset = await api.consts.slots.leaseOffset.toNumber();

    //how long a lease period is, in blocks.
    const leasePeriodDuration = await api.consts.slots.leasePeriod.toNumber();

    return {durationEndingPeriod, slotOffset, leasePeriodDuration}
}

const getScheduledActions = async () => {
    // These are the on-chain scheduled actions. Some are auctions, some are other things.
    const scheduledActions = await api.query.scheduler.agenda.entries();

    // Need to extract the information that we need. TODO: Can we use a filter directly?
    const scheduledAuctions = [];
    scheduledActions.forEach(([block_execution, call_data])=>{
        //block_execution has the information of the block at which the scheduler is scheduled to be triggered
        //call_data is an array of the calls that will be triggered at the block_execution height
        //filter only for calls that are to create a newAuction. If this is not the case, it will be an empty array.
        const actions = call_data.toHuman();
            //Ideally I would have a way of identifiying which chain has the new structure of scheduler.
            //For now it will only be kusama or non kusama.
            actions.map(value =>{
                if(value && value.call.Inline){
                   const tx = api.createType('Call', value.call.Inline);
                   const humanTx = tx.toHuman();
                   if (humanTx.method === "newAuction"){
                        value.call = {...value.call, "Value": humanTx}
                        scheduledAuctions.push({...value, "blockExecution": convertToNumber(block_execution.toHuman()[0])})
                   }
                }
           })
    })

    return scheduledAuctions
}

const getCurrentAuction = async () => {
    let activeAuctionInformation, currentAuctionEndStartBlock, currentAuctionLP;
    const auctionsCounter = (await api.query.auctions.auctionCounter()).toHuman()

    const currentAuction = (await api.query.auctions.auctionInfo()).toHuman();
    const isAuctionActive = currentAuction ? true : false;
    
    if (isAuctionActive){
        currentAuctionEndStartBlock = convertToNumber(currentAuction[1]);
        currentAuctionLP = convertToNumber(currentAuction[0]);

        activeAuctionInformation = currentAuction.length ? {
            "starting_period_block": null,
            "ending_period_start_block": currentAuctionEndStartBlock,
            "auction_end": null,
            "first_lease_period": currentAuctionLP
        } : {};
    }

    return {auctionsCounter, isAuctionActive, activeAuctionInformation, currentAuction, currentAuctionEndStartBlock, currentAuctionLP}
}

const calculateAvgBlockTime = async () => {

    const FIRST_TIMESTAMP_POLKADOT = 1590507378000
    const FIRST_TIMESTAMP_KUSAMA = 1574962074000

    const lastBlockHeader = await api.rpc.chain.getHeader();
    const lastBlockNumber = convertToNumber(lastBlockHeader.number.toHuman());
    const lastBlockHash = lastBlockHeader.hash;
    const apiAt = await api.at(lastBlockHash)
    const lastBlockTimestamp = convertToNumber((await apiAt.query.timestamp.now()).toHuman());

    let timeElapsed;
    if (chain === "polkadot"){
        timeElapsed = (lastBlockTimestamp - FIRST_TIMESTAMP_POLKADOT)/1000
    } else {
        timeElapsed = (lastBlockTimestamp - FIRST_TIMESTAMP_KUSAMA)/1000
    }
    const avgBlockTime = timeElapsed / (lastBlockNumber - 1)

    return {avgBlockTime, lastBlockNumber, lastBlockTimestamp}
    
}

const potentialRenewals = async (clp) => {
    const paraLeases = await api.query.slots.leases.entries();
    const allRemainingLeases = {};
    paraLeases.forEach(([{ args: [paraID] }, leases]) => {
        const humanParaID = convertToNumber(paraID.toHuman());
        const humanLeases = leases.toHuman();
        const remainingLeases = humanLeases.length;
        //we need to remove 1, as it's being counted on the array already.
        const lastLease = remainingLeases !== 0 ? clp + remainingLeases - 1: 0;
        const keys = Object.keys(allRemainingLeases);

        //object:
        // {reamiening_leases:[paraid1,...paraidn]}
        const paraName = findParaName(humanParaID)

        if (keys.includes(String(lastLease))){
            allRemainingLeases[lastLease] = [...allRemainingLeases[lastLease], {paraID: humanParaID, name: paraName}]
        } else {
            allRemainingLeases[lastLease] = [{paraID: humanParaID, name: paraName}]
        }
    });

    return {allRemainingLeases}
}

const findParaName = (paraID) => {
    const paraName = parachains.filter(paraInfo => paraInfo.paraid === paraID)

    return paraName.length ? paraName[0].name : "NA"
}

const endingCrowdoans = async () => {
    const allCrowdloans = await api.query.crowdloan.funds.entries()
    const unlockPerLP = {}
    allCrowdloans.forEach(([{ args: [paraID] }, crowdloanInfo]) => {
        const humanCrowdloanInfo = crowdloanInfo.toHuman();
        if (unlockPerLP[humanCrowdloanInfo.lastPeriod]) {
             unlockPerLP[humanCrowdloanInfo.lastPeriod] = unlockPerLP[humanCrowdloanInfo.lastPeriod] + convertToNumber(humanCrowdloanInfo.raised)/10000000000;
         } else {
             unlockPerLP[humanCrowdloanInfo.lastPeriod] = convertToNumber(humanCrowdloanInfo.raised)/10000000000;
        }
    })

    return {unlockPerLP}
}

const calculateTargetDate = (t, b1, b2, avg) => {
    //given the timemstamp and height of b1, and the avg block time production, this function returns the potential timestamp of b2.
    const targetTimestamp = t + ((b2-b1) * avg * 1000);
    return new Date(targetTimestamp)
}

const convertToNumber = (input) =>{
    return Number(input.split(",").join(""));
}

// calculateAvgBlockTime().catch(console.error).finally(() => process.exit());
main().catch(console.error).finally(() => process.exit());