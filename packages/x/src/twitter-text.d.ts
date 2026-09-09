declare module "twitter-text" {
  const twitterText: {
    parseTweet(text: string): { valid: boolean; weightedLength: number };
  };
  export default twitterText;
}
