import { ChangeReview, prepareReview } from '/web/index.js';
const inputs = await (await fetch('/fixture/model.json')).json();
let review;
window.reviewFixture = {
  inputs, requests: [],
  mount(name='source', options={}) {
    review?.destroy(); this.requests=[];
    const onAccept = options.accept ? selection=>this.requests.push(selection) : undefined;
    review=new ChangeReview(document.querySelector('#review'),inputs[name],{...options,...(onAccept?{onAccept}:{})});
  },
  updateInput(input){review.update(input);},
  update(name){review.update(inputs[name]);},
  mode(mode){review.setMode(mode);},
  invalid(input){return prepareReview(input);},
  destroy(){review?.destroy();},
};
window.reviewFixture.mount();
