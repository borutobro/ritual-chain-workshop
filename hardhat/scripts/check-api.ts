import hre from "hardhat";
const conn = await hre.network.connect();
const { viem } = conn;
console.log("viem methods:", Object.keys(viem).filter(k => /trans|depl|receipt|wait|client|public/i.test(k)));
