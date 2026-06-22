const calculate = (a,b) => {
    return a+b
};
const arr =[5,2,3,4,1,5,7,4]

const sumArr = (a) => {
    return a.reduce((a,b) => a+b)
}

console.log(calculate(20,35))

console.log(sumArr(arr))