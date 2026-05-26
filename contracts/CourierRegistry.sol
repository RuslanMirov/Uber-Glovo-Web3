// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CourierRegistry
 * @notice Soulbound ERC-721 that represents registered couriers.
 *         Only the contract owner (admin) can mint / burn tokens.
 *         Transfers are disabled — the NFT is bound to the courier address.
 */
contract CourierRegistry is ERC721, Ownable {

    struct CourierInfo {
        uint256 rating;        // cumulative rating points  (sum of 1-5 scores)
        uint256 ratingCount;   // number of ratings received
        uint256 ordersCount;   // total completed orders
        bool    active;        // false after admin removes courier
    }

    uint256 private _nextTokenId;

    // tokenId => info
    mapping(uint256 => CourierInfo) public couriers;
    // courier address => tokenId  (0 means not registered)
    mapping(address => uint256)    public courierToken;

    event CourierAdded(address indexed courier, uint256 indexed tokenId);
    event CourierRemoved(address indexed courier, uint256 indexed tokenId);
    event CourierRated(uint256 indexed tokenId, uint256 score, uint256 newAvg);
    event OrderCounted(uint256 indexed tokenId, uint256 newCount);

    error AlreadyRegistered();
    error NotRegistered();
    error CourierInactive();
    error SoulboundTransfer();

    constructor() ERC721("GlovoCourier", "GCOUR") Ownable(msg.sender) {
        _nextTokenId = 1; // tokenId 0 is reserved as "no token"
    }

    /* ───────── Admin functions ───────── */

    function addCourier(address courier) external onlyOwner returns (uint256 tokenId) {
        if (courierToken[courier] != 0) revert AlreadyRegistered();

        tokenId = _nextTokenId++;
        _mint(courier, tokenId);

        couriers[tokenId] = CourierInfo({
            rating: 0,
            ratingCount: 0,
            ordersCount: 0,
            active: true
        });
        courierToken[courier] = tokenId;

        emit CourierAdded(courier, tokenId);
    }

    function removeCourier(address courier) external onlyOwner {
        uint256 tokenId = courierToken[courier];
        if (tokenId == 0) revert NotRegistered();

        couriers[tokenId].active = false;
        // keep the NFT on-chain for history, just deactivate
        emit CourierRemoved(courier, tokenId);
    }

    /* ───────── Called by OrderService ───────── */

    function addRating(uint256 tokenId, uint256 score) external {
        // score 1-5, caller is OrderService — access checked there
        CourierInfo storage c = couriers[tokenId];
        if (!c.active) revert CourierInactive();
        c.rating += score;
        c.ratingCount += 1;
        emit CourierRated(tokenId, score, averageRating(tokenId));
    }

    function incrementOrders(uint256 tokenId) external {
        CourierInfo storage c = couriers[tokenId];
        if (!c.active) revert CourierInactive();
        c.ordersCount += 1;
        emit OrderCounted(tokenId, c.ordersCount);
    }

    /* ───────── Views ───────── */

    function averageRating(uint256 tokenId) public view returns (uint256) {
        CourierInfo storage c = couriers[tokenId];
        if (c.ratingCount == 0) return 0;
        return (c.rating * 100) / c.ratingCount; // 2-decimal fixed point (e.g. 450 = 4.50)
    }

    function isActiveCourier(address addr) external view returns (bool) {
        uint256 tokenId = courierToken[addr];
        if (tokenId == 0) return false;
        return couriers[tokenId].active;
    }

    /* ───────── Soulbound: block all transfers ───────── */

    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        // allow mint (from == 0) and burn (to == 0), block transfers
        if (from != address(0) && to != address(0)) {
            revert SoulboundTransfer();
        }
        return super._update(to, tokenId, auth);
    }
}
